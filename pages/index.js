// pages/index.js
import Head from "next/head";
import { useEffect, useMemo, useRef, useState } from "react";
import { initFirebaseClient, getAuthInstance, getDbInstance } from "../lib/firebaseClient";
import {
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from "firebase/auth";
import {
  collection,
  addDoc,
  query,
  orderBy,
  getDocs,
  serverTimestamp,
  doc,
  getDoc,
  setDoc,
  deleteDoc,
  onSnapshot,
  updateDoc,
  limit,
} from "firebase/firestore";

const REACTIONS = [
  { key: "like", label: "Like", emoji: "👍" },
  { key: "love", label: "Love", emoji: "❤️" },
  { key: "haha", label: "Haha", emoji: "😂" },
  { key: "sad", label: "Sad", emoji: "😢" },
];

export default function Home() {
  const [initialized, setInitialized] = useState(false);
  const [user, setUser] = useState(null);

  const [selectedFiles, setSelectedFiles] = useState([]);
  const [uploads, setUploads] = useState([]);
  const [comments, setComments] = useState({});
  const [commentText, setCommentText] = useState({});
  const [replyText, setReplyText] = useState({});
  const [showReplyInput, setShowReplyInput] = useState({});
  const [expandedReplies, setExpandedReplies] = useState({});
  const [uploading, setUploading] = useState(false);
  const [postCaption, setPostCaption] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [activeCommentPost, setActiveCommentPost] = useState(null);
  const [notifications, setNotifications] = useState([]);
  const [showNotifications, setShowNotifications] = useState(false);

  const [reactionPickerFor, setReactionPickerFor] = useState(null);
  const [userReactions, setUserReactions] = useState({});
  const [reactionSummaries, setReactionSummaries] = useState({});

  const authRef = useRef(null);
  const dbRef = useRef(null);
  const providerRef = useRef(new GoogleAuthProvider());

  function openComments(postId) {
    setActiveCommentPost(postId);
  }

  function closeComments() {
    setActiveCommentPost(null);
  }

  useEffect(() => {
    let unsubscribe = null;

    const init = async () => {
      await initFirebaseClient();
      authRef.current = getAuthInstance();
      dbRef.current = getDbInstance();
      setInitialized(true);

      if (authRef.current) {
        unsubscribe = onAuthStateChanged(authRef.current, (u) => {
          setUser(u || null);
        });
      }
    };

    init();

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!initialized || !dbRef.current) return;
    loadRecent();
  }, [initialized, user]);

  useEffect(() => {
    if (!initialized || !dbRef.current || !user) {
      setNotifications([]);
      return;
    }

    const q = query(
      collection(dbRef.current, `users/${user.uid}/notifications`),
      orderBy("createdAt", "desc"),
      limit(20)
    );

    const unsub = onSnapshot(
      q,
      (snap) => {
        const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        setNotifications(items);
      },
      (err) => {
        console.error("Notification listener error:", err);
      }
    );

    return () => unsub();
  }, [initialized, user]);

  async function loadRecent() {
    try {
      const q = query(collection(dbRef.current, "uploads"), orderBy("createdAt", "desc"));
      const snap = await getDocs(q);
      const posts = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      setUploads(posts);

      const commentsData = {};
      const myReactions = {};
      const reactionData = {};

      for (const post of posts) {
        try {
          const cQ = query(
            collection(dbRef.current, `uploads/${post.id}/comments`),
            orderBy("createdAt", "asc")
          );
          const cSnap = await getDocs(cQ);
          const flatComments = cSnap.docs.map((c) => ({
            id: c.id,
            ...c.data(),
            replies: [],
          }));

          const commentMap = {};
          const roots = [];

          flatComments.forEach((comment) => {
            commentMap[comment.id] = { ...comment };
          });

          flatComments.forEach((comment) => {
            if (comment.parentId) {
              if (commentMap[comment.parentId]) {
                commentMap[comment.parentId].replies =
                  commentMap[comment.parentId].replies || [];
                commentMap[comment.parentId].replies.push(commentMap[comment.id]);
              }
            } else {
              roots.push(commentMap[comment.id]);
            }
          });

          commentsData[post.id] = roots;
        } catch (err) {
          console.error("Error loading comments:", post.id, err);
          commentsData[post.id] = [];
        }

        try {
          const rSnap = await getDocs(collection(dbRef.current, `uploads/${post.id}/reactions`));
          const counts = { like: 0, love: 0, haha: 0, sad: 0, total: 0 };

          rSnap.docs.forEach((r) => {
            const data = r.data();
            if (data?.type && counts[data.type] !== undefined) {
              counts[data.type] += 1;
              counts.total += 1;
            }
            if (user && r.id === user.uid) {
              myReactions[post.id] = data?.type || null;
            }
          });

          reactionData[post.id] = counts;
        } catch (err) {
          console.error("Error loading reactions:", post.id, err);
          reactionData[post.id] = { like: 0, love: 0, haha: 0, sad: 0, total: 0 };
        }
      }

      setComments(commentsData);
      setUserReactions(myReactions);
      setReactionSummaries(reactionData);
    } catch (e) {
      console.error("load error:", e);
    }
  }

  async function createNotification({
    toUid,
    fromUid,
    fromName,
    fromPhoto,
    type,
    postId,
    postText = "",
    reactionType = "",
    commentText = "",
  }) {
    if (!toUid || !fromUid) return;
    if (toUid === fromUid) return;

    try {
      await addDoc(collection(dbRef.current, `users/${toUid}/notifications`), {
        toUid,
        fromUid,
        fromName: fromName || "Someone",
        fromPhoto: fromPhoto || "",
        type,
        postId,
        postText: postText || "",
        reactionType: reactionType || "",
        commentText: commentText || "",
        isRead: false,
        createdAt: serverTimestamp(),
      });
    } catch (e) {
      console.error("Failed to create notification:", e);
    }
  }

  async function markNotificationsAsRead() {
    if (!user || !dbRef.current) return;

    try {
      const unread = notifications.filter((n) => !n.isRead);
      await Promise.all(
        unread.map((n) =>
          updateDoc(doc(dbRef.current, `users/${user.uid}/notifications/${n.id}`), {
            isRead: true,
          })
        )
      );
    } catch (e) {
      console.error("Failed to mark notifications as read:", e);
    }
  }

  async function toggleNotifications() {
    const next = !showNotifications;
    setShowNotifications(next);
    if (next) {
      await markNotificationsAsRead();
    }
  }

  async function handleReaction(post, reactionType) {
    if (!user) {
      alert("Please login first!");
      return;
    }

    try {
      const reactionRef = doc(dbRef.current, `uploads/${post.id}/reactions/${user.uid}`);
      const snap = await getDoc(reactionRef);
      const existingType = snap.exists() ? snap.data()?.type : null;

      if (existingType === reactionType) {
        await deleteDoc(reactionRef);
      } else {
        await setDoc(reactionRef, {
          uid: user.uid,
          name: user.displayName || "User",
          avatar: user.photoURL || "",
          type: reactionType,
          createdAt: serverTimestamp(),
        });

        await createNotification({
          toUid: post.ownerUid,
          fromUid: user.uid,
          fromName: user.displayName,
          fromPhoto: user.photoURL,
          type: "reaction",
          postId: post.id,
          postText: post.text || "",
          reactionType,
        });
      }

      setReactionPickerFor(null);
      await loadRecent();
    } catch (e) {
      console.error("Reaction error:", e);
      alert("Failed to react: " + e.message);
    }
  }

  async function handleCommentSubmit(postId, parentId = null) {
    const text = parentId ? replyText[`${postId}-${parentId}`] : commentText[postId];
    if (!text || !user) return;

    const trimmed = text.trim();
    if (!trimmed) return;

    const commentData = {
      uid: user.uid,
      name: user.displayName,
      avatar: user.photoURL || "",
      text: trimmed,
      createdAt: serverTimestamp(),
      likes: 0,
      parentId: parentId || null,
    };

    try {
      await addDoc(collection(dbRef.current, `uploads/${postId}/comments`), commentData);

      const post = uploads.find((p) => p.id === postId);
      if (post) {
        await createNotification({
          toUid: post.ownerUid,
          fromUid: user.uid,
          fromName: user.displayName,
          fromPhoto: user.photoURL,
          type: parentId ? "reply" : "comment",
          postId,
          postText: post.text || "",
          commentText: trimmed,
        });
      }

      if (parentId) {
        setReplyText((prev) => ({ ...prev, [`${postId}-${parentId}`]: "" }));
        setShowReplyInput((prev) => ({ ...prev, [`${postId}-${parentId}`]: false }));
      } else {
        setCommentText((prev) => ({ ...prev, [postId]: "" }));
      }

      await loadRecent();
    } catch (e) {
      console.error("Error submitting comment:", e);
      alert("Failed to submit comment: " + e.message);
    }
  }

  function toggleReplyInput(postId, commentId) {
    setShowReplyInput((prev) => ({
      ...prev,
      [`${postId}-${commentId}`]: !prev[`${postId}-${commentId}`],
    }));
  }

  function toggleReplies(postId, commentId) {
    setExpandedReplies((prev) => ({
      ...prev,
      [`${postId}-${commentId}`]: !prev[`${postId}-${commentId}`],
    }));
  }

  async function handleUploadAll() {
    if (!user) {
      alert("Please login first!");
      return;
    }
    if (selectedFiles.length === 0) {
      alert("Please select files first!");
      return;
    }

    setUploading(true);

    try {
      for (let i = 0; i < selectedFiles.length; i++) {
        const f = selectedFiles[i];

        try {
          const token = await user.getIdToken(true);

          const sigRes = await fetch("/api/signature", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ folder: `user_${user.uid}` }),
          });

          if (!sigRes.ok) {
            throw new Error(`Signature request failed: ${sigRes.status}`);
          }

          const sigJson = await sigRes.json();

          if (!sigJson.ok) {
            throw new Error(`Signature failed: ${sigJson.details || JSON.stringify(sigJson)}`);
          }

          const form = new FormData();
          form.append("file", f);
          form.append("api_key", sigJson.api_key);
          form.append("timestamp", sigJson.timestamp);
          form.append("signature", sigJson.signature);
          form.append("folder", `user_${user.uid}`);

          const cloudinaryUrl = `https://api.cloudinary.com/v1_1/${sigJson.cloud_name}/auto/upload`;
          const uploadRes = await fetch(cloudinaryUrl, { method: "POST", body: form });

          if (!uploadRes.ok) {
            throw new Error(`Cloudinary upload failed: ${uploadRes.status}`);
          }

          const uploadJson = await uploadRes.json();

          if (uploadJson.secure_url) {
            await addDoc(collection(dbRef.current, "uploads"), {
              ownerUid: user.uid,
              ownerName: user.displayName,
              ownerPhoto: user.photoURL || "",
              url: uploadJson.secure_url,
              resource_type: uploadJson.resource_type,
              fileName: uploadJson.original_filename || f.name,
              format: uploadJson.format,
              public_id: uploadJson.public_id,
              text: postCaption || "",
              createdAt: serverTimestamp(),
              likes: 0,
              commentsCount: 0,
            });
          } else {
            throw new Error("No secure_url in response");
          }

          if (i < selectedFiles.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        } catch (fileError) {
          console.error(`Error uploading file ${f.name}:`, fileError);
          alert(`Failed to upload ${f.name}: ${fileError.message}`);
        }
      }

      setSelectedFiles([]);
      setPostCaption("");
      await loadRecent();
      alert("Upload completed successfully!");
    } catch (e) {
      console.error("Upload error:", e);
      alert("Upload failed: " + e.message);
    } finally {
      setUploading(false);
    }
  }

  async function handlePostCaptionOnly() {
    if (!user) {
      alert("Please login first!");
      return;
    }
    if (!postCaption?.trim()) {
      alert("Caption is empty.");
      return;
    }

    setUploading(true);
    try {
      await addDoc(collection(dbRef.current, "uploads"), {
        ownerUid: user.uid,
        ownerName: user.displayName,
        ownerPhoto: user.photoURL || "",
        url: "",
        resource_type: "text",
        fileName: "",
        format: "",
        public_id: "",
        text: postCaption,
        createdAt: serverTimestamp(),
        likes: 0,
        commentsCount: 0,
      });

      setPostCaption("");
      await loadRecent();
      alert("Post created!");
    } catch (e) {
      console.error("Failed to create caption post:", e);
      alert("Failed to post caption: " + (e.message || String(e)));
    } finally {
      setUploading(false);
    }
  }

  async function handleCreatePost() {
    if (!user) {
      alert("Please login first!");
      return;
    }
    if (selectedFiles.length > 0) {
      await handleUploadAll();
      return;
    }
    if (postCaption?.trim()) {
      await handlePostCaptionOnly();
      return;
    }
    alert("Nothing to post. Add a caption or select files.");
  }

  async function handleLogin() {
    try {
      if (!authRef.current) {
        await initFirebaseClient();
        authRef.current = getAuthInstance();
      }

      providerRef.current.addScope("profile");
      providerRef.current.addScope("email");

      const result = await signInWithPopup(authRef.current, providerRef.current);
      setUser(result.user);
    } catch (error) {
      console.error("Login error:", error);

      if (error.code === "auth/popup-blocked") {
        alert("Popup was blocked by your browser. Please allow popups for this site.");
      } else if (error.code === "auth/popup-closed-by-user") {
        console.log("Popup closed by user");
      } else {
        alert("Login error: " + error.message);
      }
    }
  }

  async function handleLogout() {
    try {
      if (authRef.current) {
        await signOut(authRef.current);
      }
    } catch (error) {
      console.error("Logout error:", error);
    }
  }

  function handleFileChange(e) {
    const files = Array.from(e.target.files || []);
    setSelectedFiles(files);
  }

  function formatTimeAgo(timestamp) {
    if (!timestamp) return "Just now";
    try {
      const date = timestamp?.toDate ? timestamp.toDate() : new Date(timestamp);
      const now = new Date();
      const diff = now - date;
      const minutes = Math.floor(diff / 60000);
      const hours = Math.floor(minutes / 60);
      const days = Math.floor(hours / 24);

      if (days > 0) return `${days}d ago`;
      if (hours > 0) return `${hours}h ago`;
      if (minutes > 0) return `${minutes}m ago`;
      return "Just now";
    } catch {
      return "Recently";
    }
  }

  async function handleDownload(post) {
    if (!post || !post.url) {
      alert("No file to download.");
      return;
    }

    try {
      const res = await fetch(post.url, { mode: "cors" });
      if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);

      const blob = await res.blob();
      let filename = post.fileName || post.public_id || "download";

      if (post.format && !filename.toLowerCase().endsWith("." + post.format.toLowerCase())) {
        filename = `${filename}.${post.format}`;
      } else if (!/\.[a-zA-Z0-9]{1,6}$/.test(filename)) {
        const urlName = post.url.split("?")[0].split("/").pop();
        if (urlName) filename = urlName;
      }

      const link = document.createElement("a");
      const url = URL.createObjectURL(blob);
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Download failed, opening in new tab", err);
      window.open(post.url, "_blank");
    }
  }

  function renderNotificationText(notif) {
    if (notif.type === "reaction") {
      const reaction = REACTIONS.find((r) => r.key === notif.reactionType);
      return (
        <>
          <strong>{notif.fromName}</strong> reacted to your post with{" "}
          {reaction?.emoji || "👍"} {reaction?.label || notif.reactionType}
        </>
      );
    }

    if (notif.type === "reply") {
      return (
        <>
          <strong>{notif.fromName}</strong> replied on your post
        </>
      );
    }

    return (
      <>
        <strong>{notif.fromName}</strong> commented on your post
      </>
    );
  }

  function renderComment(comment, postId, depth = 0) {
    const hasReplies = comment.replies && comment.replies.length > 0;
    const isExpanded = expandedReplies[`${postId}-${comment.id}`];

    return (
      <div key={comment.id} className={`comment-item ${depth > 0 ? "reply" : ""}`}>
        <div className="comment-avatar">
          {comment.avatar ? (
            <img src={comment.avatar} alt={comment.name} />
          ) : (
            <div className="avatar-placeholder">{comment.name?.charAt(0) || "U"}</div>
          )}
        </div>

        <div className="comment-content">
          <div className="comment-header">
            <span className="comment-author">{comment.name}</span>
            <span className="comment-time">{formatTimeAgo(comment.createdAt)}</span>
          </div>

          <div className="comment-text">{comment.text}</div>

          <div className="comment-actions">
            <button className="comment-action-btn" onClick={() => toggleReplyInput(postId, comment.id)}>
              ↩️ Reply
            </button>

            {hasReplies && (
              <button className="comment-action-btn" onClick={() => toggleReplies(postId, comment.id)}>
                {isExpanded ? "Hide" : "Show"} replies ({comment.replies.length})
              </button>
            )}
          </div>

          {showReplyInput[`${postId}-${comment.id}`] && (
            <div className="reply-input-container">
              <input
                type="text"
                placeholder="Write a reply..."
                value={replyText[`${postId}-${comment.id}`] || ""}
                onChange={(e) =>
                  setReplyText((prev) => ({
                    ...prev,
                    [`${postId}-${comment.id}`]: e.target.value,
                  }))
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCommentSubmit(postId, comment.id);
                }}
              />
              <button className="send-reply-btn" onClick={() => handleCommentSubmit(postId, comment.id)}>
                Send
              </button>
            </div>
          )}

          {hasReplies && isExpanded && (
            <div className="replies-container">
              {comment.replies.map((reply) => renderComment(reply, postId, depth + 1))}
            </div>
          )}
        </div>
      </div>
    );
  }

  const filteredUploads = useMemo(() => {
    if (!searchQuery?.trim()) return uploads;
    const q = searchQuery.trim().toLowerCase();
    return uploads.filter((p) => (p.text || "").toLowerCase().includes(q));
  }, [uploads, searchQuery]);

  const unreadCount = notifications.filter((n) => !n.isRead).length;

  return (
    <>
      <Head>
        <title>POSTREAM</title>
        <link
          rel="stylesheet"
          href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css"
        />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <div className="layout">
        <header className="header">
          <div className="header-left">
            <div className="logo">
              <i className="fas fa-fire logo-icon"></i>
              <span>POSTREAM</span>
            </div>
          </div>

          <div className="header-center">
            <input
              type="search"
              placeholder="Search captions..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="search-input"
            />
          </div>

          <div className="header-right">
            {user && (
              <div className="notification-wrapper">
                <button className="notification-btn" onClick={toggleNotifications} title="Notifications">
                  <i className="fas fa-bell"></i>
                  {unreadCount > 0 && <span className="notification-badge">{unreadCount}</span>}
                </button>

                {showNotifications && (
                  <div className="notification-dropdown">
                    <div className="notification-title">Notifications</div>

                    {notifications.length === 0 ? (
                      <div className="notification-empty">No notifications yet</div>
                    ) : (
                      notifications.map((notif) => (
                        <div key={notif.id} className="notification-item">
                          <div className="notification-avatar">
                            {notif.fromPhoto ? (
                              <img src={notif.fromPhoto} alt={notif.fromName} />
                            ) : (
                              <div className="avatar-placeholder small">
                                {notif.fromName?.charAt(0) || "U"}
                              </div>
                            )}
                          </div>

                          <div className="notification-content">
                            <div className="notification-text">{renderNotificationText(notif)}</div>

                            {notif.commentText ? (
                              <div className="notification-preview">“{notif.commentText}”</div>
                            ) : null}

                            <div className="notification-time">
                              {formatTimeAgo(notif.createdAt)}
                            </div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            )}

            {!user ? (
              <button className="login-btn" onClick={handleLogin}>
                <i className="fab fa-google"></i> Login with Google
              </button>
            ) : (
              <div className="user-info-header">
                <div className="user-avatar-header">
                  {user.photoURL ? (
                    <img src={user.photoURL} alt={user.displayName} />
                  ) : (
                    <div className="avatar-placeholder">{user.displayName?.charAt(0) || "U"}</div>
                  )}
                </div>

                <div className="user-details">
                  <div className="user-name">{user.displayName}</div>
                  <div className="user-status">
                    <span className="status-dot"></span>
                    Online
                  </div>
                </div>

                <button className="logout-btn" onClick={handleLogout} title="Logout">
                  <i className="fas fa-sign-out-alt"></i>
                </button>
              </div>
            )}
          </div>
        </header>

        <main className="main-content">
          <aside className="sidebar left-sidebar">
            {user && (
              <div className="upload-section">
                <div className="section-header">
                  <i className="fas fa-cloud-upload-alt"></i>
                  <h3>Upload Content</h3>
                </div>

                <div className="file-upload-area">
                  <textarea
                    placeholder="Caption..."
                    value={postCaption}
                    onChange={(e) => setPostCaption(e.target.value)}
                    rows={3}
                    className="caption-input"
                  />

                  <label className="file-input-label">
                    <div className="file-input-icon">
                      <i className="fas fa-folder-open"></i>
                    </div>
                    <div className="file-input-text">
                      <div className="file-input-title">Choose Files</div>
                      <div className="file-input-subtitle">PNG, JPG, MP4 up to 10MB</div>
                    </div>
                    <input
                      type="file"
                      multiple
                      onChange={handleFileChange}
                      className="file-input"
                      disabled={uploading}
                    />
                  </label>

                  {selectedFiles.length > 0 && (
                    <div className="selected-files-list">
                      <div className="selected-files-header">
                        <i className="fas fa-paperclip"></i>
                        <span>Selected Files ({selectedFiles.length})</span>
                      </div>

                      <div className="files-preview">
                        {selectedFiles.slice(0, 2).map((file, idx) => (
                          <div key={idx} className="file-preview-item">
                            <i className={file.type.startsWith("image/") ? "fas fa-image" : "fas fa-video"}></i>
                            <span className="file-name">{file.name}</span>
                            <span className="file-size">({(file.size / 1024 / 1024).toFixed(1)} MB)</span>
                          </div>
                        ))}

                        {selectedFiles.length > 2 && (
                          <div className="more-files-count">+{selectedFiles.length - 2} more files</div>
                        )}
                      </div>
                    </div>
                  )}

                  <button
                    className={`upload-action-btn ${uploading ? "uploading" : ""}`}
                    onClick={handleCreatePost}
                    disabled={uploading || (selectedFiles.length === 0 && !postCaption.trim())}
                  >
                    {uploading ? (
                      <>
                        <i className="fas fa-spinner fa-spin"></i>
                        Creating...
                      </>
                    ) : (
                      <>
                        <i className="fas fa-plus-circle"></i>
                        Create Post
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}
          </aside>

          <section className="main-feed">
            {filteredUploads.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon">
                  <i className="fas fa-stream"></i>
                </div>
                <h3>Welcome to POSTREAM</h3>
                <p>{user ? "No posts match your search." : "Login to start sharing content"}</p>
                {!user && (
                  <button className="empty-state-btn" onClick={handleLogin}>
                    <i className="fab fa-google"></i> Get Started
                  </button>
                )}
              </div>
            ) : (
              filteredUploads.map((post) => {
                const summary = reactionSummaries[post.id] || {
                  like: 0,
                  love: 0,
                  haha: 0,
                  sad: 0,
                  total: 0,
                };

                const myReaction = userReactions[post.id];
                const currentReaction = REACTIONS.find((r) => r.key === myReaction);

                return (
                  <article key={post.id} className="post-card">
                    <div className="post-header">
                      <div className="post-author-info">
                        <div className="post-avatar">
                          {post.ownerPhoto ? (
                            <img src={post.ownerPhoto} alt={post.ownerName} />
                          ) : (
                            <div className="avatar-placeholder">
                              {post.ownerName?.charAt(0) || "U"}
                            </div>
                          )}
                        </div>

                        <div className="author-details">
                          <div className="author-name">{post.ownerName}</div>
                          <div className="post-time">{formatTimeAgo(post.createdAt)}</div>
                        </div>
                      </div>

                      <button
                        className="post-menu-btn download-btn"
                        title="Download"
                        onClick={() => handleDownload(post)}
                        disabled={!post.url}
                        aria-disabled={!post.url}
                      >
                        <i className="fas fa-download"></i>
                      </button>
                    </div>

                    {post.text && <div className="post-caption">{post.text}</div>}

                    {post.url && (
                      <div className="post-media-container">
                        {post.resource_type === "image" ? (
                          <img
                            src={post.url}
                            className="post-media-image"
                            alt={post.fileName || "post media"}
                            loading="lazy"
                          />
                        ) : (
                          <video
                            src={post.url}
                            className="post-media-video"
                            controls
                            preload="metadata"
                          />
                        )}
                      </div>
                    )}

                    <div className="post-reaction-summary">
                      <div className="reaction-summary-left">
                        {summary.like > 0 && <span>👍 {summary.like}</span>}
                        {summary.love > 0 && <span>❤️ {summary.love}</span>}
                        {summary.haha > 0 && <span>😂 {summary.haha}</span>}
                        {summary.sad > 0 && <span>😢 {summary.sad}</span>}
                      </div>
                      <div className="reaction-summary-right">
                        {(comments[post.id] || []).length} comments
                      </div>
                    </div>

                    <div className="post-actions">
                      <div className="reaction-area">
                      <button
                        className={`post-action-btn ${myReaction ? "active-reaction" : ""}`}
                        onClick={() => {
                          if (!user) {
                            alert("Please login first!");
                            return;
                          }

                          setReactionPickerFor((prev) => (prev === post.id ? null : post.id));
                        }}
                      >
                        <span style={{ fontSize: 18 }}>{currentReaction?.emoji || "👍"}</span>
                        <span>{currentReaction?.label || "Like"}</span>
                      </button>

                      {reactionPickerFor === post.id && (
                        <div className="reaction-picker">
                          {REACTIONS.map((reaction) => (
                            <button
                              key={reaction.key}
                              className="reaction-option"
                              onClick={() => handleReaction(post, reaction.key)}
                              title={reaction.label}
                              type="button"
                            >
                              {reaction.emoji}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                      <button
                        className="post-action-btn"
                        onClick={() => openComments(post.id)}
                      >
                        <i className="far fa-comment"></i>
                        <span>Comment</span>
                      </button>
                    </div>
                  </article>
                );
              })
            )}
          </section>

          <aside className="sidebar right-sidebar">
            {user && (
              <div className="profile-card">
                <div className="profile-header">
                  <div className="profile-avatar">
                    {user.photoURL ? (
                      <img src={user.photoURL} alt={user.displayName} />
                    ) : (
                      <div className="avatar-placeholder large">
                        {user.displayName?.charAt(0) || "U"}
                      </div>
                    )}
                  </div>

                  <div className="profile-info">
                    <div className="profile-name">{user.displayName}</div>
                    <div className="profile-email">{user.email}</div>
                  </div>
                </div>

                <div className="profile-stats">
                  <div className="profile-stat">
                    <div className="stat-value">{uploads.filter((u) => u.ownerUid === user.uid).length}</div>
                    <div className="stat-label">Posts</div>
                  </div>

                  <div className="profile-stat">
                    <div className="stat-value">
                      {Object.values(comments).flat().filter((c) => c && c.uid === user.uid).length}
                    </div>
                    <div className="stat-label">Comments</div>
                  </div>

                  <div className="profile-stat">
                    <div className="stat-value">{notifications.length}</div>
                    <div className="stat-label">Notif</div>
                  </div>
                </div>
              </div>
            )}
          </aside>
        </main>

        {activeCommentPost && (
  <div className="comment-modal-overlay" onClick={closeComments}>
    <div
      className="comment-modal"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="comment-modal-header">
        <h3>Comments</h3>
        <button className="comment-modal-close" onClick={closeComments}>
          <i className="fas fa-times"></i>
        </button>
      </div>

      <div className="comment-modal-body">
        {(() => {
          const post = uploads.find((p) => p.id === activeCommentPost);
          if (!post) return null;

          return (
            <>
              <div className="comment-modal-post-preview">
                <div className="comment-modal-post-author">
                  <div className="post-avatar">
                    {post.ownerPhoto ? (
                      <img src={post.ownerPhoto} alt={post.ownerName} />
                    ) : (
                      <div className="avatar-placeholder">
                        {post.ownerName?.charAt(0) || "U"}
                      </div>
                    )}
                  </div>

                  <div>
                    <div className="author-name">{post.ownerName}</div>
                    <div className="post-time">{formatTimeAgo(post.createdAt)}</div>
                  </div>
                </div>

                {post.text && <div className="post-caption">{post.text}</div>}
              </div>

              <div className="comments-list modal-comments-list">
                {comments[post.id]?.length > 0 ? (
                  comments[post.id].map((comment) => renderComment(comment, post.id))
                ) : (
                  <div className="no-comments">No comments yet</div>
                )}
              </div>
            </>
          );
        })()}
      </div>

      {user && (
        <div className="comment-modal-footer">
          <div className="comment-input-wrapper">
            <div className="comment-avatar-small">
              {user.photoURL ? (
                <img src={user.photoURL} alt={user.displayName} />
              ) : (
                <div className="avatar-placeholder small">
                  {user.displayName?.charAt(0) || "U"}
                </div>
              )}
            </div>

            <div className="comment-input-group">
              <input
                id={`comment-input-${activeCommentPost}`}
                type="text"
                placeholder="Write a comment..."
                value={commentText[activeCommentPost] || ""}
                onChange={(e) =>
                  setCommentText((prev) => ({
                    ...prev,
                    [activeCommentPost]: e.target.value,
                  }))
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCommentSubmit(activeCommentPost);
                }}
                className="comment-input"
              />
              <button
                className="comment-submit-btn"
                onClick={() => handleCommentSubmit(activeCommentPost)}
                disabled={!commentText[activeCommentPost]?.trim()}
              >
                <i className="fas fa-paper-plane"></i>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  </div>
)}
      </div>

      <style jsx global>{`
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }

        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", sans-serif;
          background: #0a0a0a;
          color: #fff;
          line-height: 1.5;
          overflow-x: hidden;
        }

        .header {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          height: 60px;
          background: linear-gradient(90deg, #1a0000 0%, #330000 100%);
          border-bottom: 1px solid rgba(255, 0, 0, 0.2);
          display: flex;
          align-items: center;
          padding: 0 24px;
          z-index: 1000;
        }

        .header-left {
          display: flex;
          align-items: center;
          width: 240px;
        }

        .logo {
          display: flex;
          align-items: center;
          gap: 10px;
          font-size: 24px;
          font-weight: 800;
          background: linear-gradient(45deg, #ff3333, #ff6666);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
        }

        .header-center {
          flex: 1;
          display: flex;
          justify-content: center;
        }

        .search-input {
          width: 60%;
          max-width: 520px;
          min-width: 220px;
          padding: 8px 12px;
          border-radius: 18px;
          border: 1px solid rgba(255, 255, 255, 0.06);
          background: rgba(255, 255, 255, 0.02);
          color: #fff;
          outline: none;
        }

        .search-input::placeholder {
          color: #bbb;
        }

        .header-right {
          display: flex;
          align-items: center;
          gap: 12px;
          width: 320px;
          justify-content: flex-end;
          position: relative;
        }

        .login-btn {
          background: linear-gradient(45deg, #ff3333, #ff6666);
          border: none;
          padding: 10px 20px;
          border-radius: 8px;
          color: white;
          font-weight: 600;
          cursor: pointer;
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .user-info-header {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .comment-modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.72);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 3000;
  padding: 20px;
}

.comment-modal {
  width: 100%;
  max-width: 760px;
  max-height: 85vh;
  background: #140404;
  border: 1px solid rgba(255, 0, 0, 0.25);
  border-radius: 18px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.45);
}

.comment-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.comment-modal-header h3 {
  margin: 0;
  font-size: 18px;
  color: #fff;
}

.comment-modal-close {
  width: 38px;
  height: 38px;
  border: none;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.05);
  color: #fff;
  cursor: pointer;
}

.comment-modal-body {
  flex: 1;
  overflow-y: auto;
  padding: 18px 20px;
}

.comment-modal-post-preview {
  padding-bottom: 16px;
  margin-bottom: 18px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.comment-modal-post-author {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
}

.modal-comments-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.comment-modal-footer {
  padding: 16px 20px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  background: #120202;
}

        .user-avatar-header,
        .post-avatar,
        .comment-avatar,
        .profile-avatar,
        .comment-avatar-small,
        .notification-avatar {
          border-radius: 50%;
          overflow: hidden;
        }

        .user-avatar-header {
          width: 40px;
          height: 40px;
          border: 2px solid #ff3333;
        }

        .user-avatar-header img,
        .post-avatar img,
        .comment-avatar img,
        .profile-avatar img,
        .comment-avatar-small img,
        .notification-avatar img {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }

        .user-details {
          display: flex;
          flex-direction: column;
        }

        .user-name {
          font-weight: 600;
          font-size: 14px;
        }

        .user-status {
          display: flex;
          align-items: center;
          gap: 4px;
          font-size: 12px;
          color: #00ff66;
        }

        .status-dot {
          width: 8px;
          height: 8px;
          background: #00ff66;
          border-radius: 50%;
        }

        .logout-btn,
        .notification-btn {
          background: rgba(255, 0, 0, 0.1);
          border: 1px solid rgba(255, 0, 0, 0.3);
          color: #ff6666;
          width: 38px;
          height: 38px;
          border-radius: 10px;
          cursor: pointer;
        }

        .notification-wrapper {
          position: relative;
        }

        .notification-badge {
          position: absolute;
          top: -6px;
          right: -6px;
          background: #ff3333;
          color: #fff;
          font-size: 11px;
          min-width: 18px;
          height: 18px;
          border-radius: 999px;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 0 5px;
          font-weight: 700;
        }

        .notification-dropdown {
          position: absolute;
          top: 48px;
          right: 0;
          width: 340px;
          max-height: 420px;
          overflow-y: auto;
          background: #140404;
          border: 1px solid rgba(255, 0, 0, 0.25);
          border-radius: 14px;
          box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
          z-index: 2000;
          padding: 12px;
        }

        .notification-title {
          font-size: 16px;
          font-weight: 700;
          color: white;
          margin-bottom: 10px;
        }

        .notification-empty {
          color: #888;
          padding: 12px 4px;
        }

        .notification-item {
          display: flex;
          gap: 10px;
          padding: 10px 6px;
          border-radius: 10px;
        }

        .notification-item:hover {
          background: rgba(255, 255, 255, 0.03);
        }

        .notification-avatar {
          width: 36px;
          height: 36px;
          flex-shrink: 0;
        }

        .notification-content {
          flex: 1;
        }

        .notification-text {
          color: #fff;
          font-size: 13px;
          line-height: 1.4;
        }

        .notification-preview {
          color: #aaa;
          font-size: 12px;
          margin-top: 4px;
        }

        .notification-time {
          color: #666;
          font-size: 11px;
          margin-top: 4px;
        }

        .main-content {
          display: grid;
          grid-template-columns: 320px 1fr 320px;
          gap: 24px;
          max-width: 1400px;
          margin: 80px auto 0;
          padding: 0 24px 40px;
          min-height: calc(100vh - 60px);
        }

        .sidebar {
          position: sticky;
          top: 80px;
          height: fit-content;
        }

        .upload-section,
        .profile-card,
        .post-card {
          background: rgba(26, 0, 0, 0.82);
          border: 1px solid rgba(255, 0, 0, 0.18);
          border-radius: 16px;
          backdrop-filter: blur(10px);
        }

        .upload-section,
        .profile-card {
          padding: 20px;
        }

        .section-header {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-bottom: 20px;
        }

        .section-header i {
          color: #ff3333;
        }

        .file-upload-area {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }

        .caption-input {
          width: 100%;
          border-radius: 10px;
          padding: 10px;
          resize: vertical;
          background: rgba(255, 255, 255, 0.03);
          color: #fff;
          border: 1px solid rgba(255, 51, 51, 0.15);
          outline: none;
        }

        .file-input-label {
          display: flex;
          align-items: center;
          gap: 15px;
          padding: 20px;
          background: rgba(255, 51, 51, 0.05);
          border: 2px dashed rgba(255, 51, 51, 0.3);
          border-radius: 12px;
          cursor: pointer;
        }

        .file-input {
          display: none;
        }

        .file-input-icon {
          width: 48px;
          height: 48px;
          background: rgba(255, 51, 51, 0.1);
          border-radius: 12px;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .file-input-title {
          font-weight: 600;
        }

        .file-input-subtitle {
          font-size: 13px;
          color: #888;
        }

        .selected-files-list {
          background: rgba(0, 0, 0, 0.3);
          border-radius: 12px;
          padding: 16px;
        }

        .selected-files-header,
        .file-preview-item {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .files-preview {
          display: flex;
          flex-direction: column;
          gap: 8px;
          margin-top: 10px;
        }

        .file-preview-item {
          padding: 10px;
          background: rgba(255, 255, 255, 0.05);
          border-radius: 8px;
          font-size: 13px;
        }

        .file-name {
          flex: 1;
          overflow: hidden;
          white-space: nowrap;
          text-overflow: ellipsis;
        }

        .file-size {
          color: #888;
          font-size: 11px;
        }

        .more-files-count {
          text-align: center;
          padding: 8px;
          color: #ff6666;
          font-size: 12px;
          background: rgba(255, 51, 51, 0.1);
          border-radius: 6px;
        }

        .upload-action-btn,
        .empty-state-btn {
          width: 100%;
          background: linear-gradient(45deg, #ff3333, #ff6666);
          border: none;
          padding: 14px;
          border-radius: 12px;
          color: white;
          font-weight: 600;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 10px;
        }

        .upload-action-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .main-feed {
          display: flex;
          flex-direction: column;
          gap: 20px;
        }

        .empty-state {
          text-align: center;
          padding: 60px 20px;
          background: rgba(26, 0, 0, 0.82);
          border: 1px solid rgba(255, 0, 0, 0.18);
          border-radius: 16px;
        }

        .post-card {
          overflow: hidden;
        }

        .post-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 16px 20px;
        }

        .post-author-info {
          display: flex;
          gap: 12px;
          align-items: center;
        }

        .post-avatar {
          width: 44px;
          height: 44px;
        }

        .author-name {
          font-weight: 700;
        }

        .post-time {
          font-size: 12px;
          color: #aaa;
        }

        .download-btn {
          background: rgba(255, 0, 0, 0.08);
          border: 1px solid rgba(255, 0, 0, 0.18);
          color: #ff7777;
          width: 38px;
          height: 38px;
          border-radius: 10px;
          cursor: pointer;
        }

        .download-btn:disabled {
          opacity: 0.35;
          cursor: not-allowed;
        }

        .post-caption {
          padding: 0 20px 14px;
          color: #f3f3f3;
          white-space: pre-wrap;
        }

        .post-media-container {
          width: 100%;
          max-height: 550px;
          background: #000;
        }

        .post-media-image,
        .post-media-video {
          width: 100%;
          display: block;
          max-height: 550px;
          object-fit: contain;
        }

        .post-reaction-summary {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 12px 20px 0;
          color: #bbb;
          font-size: 13px;
        }

        .reaction-summary-left {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
        }

        .reaction-summary-right {
          color: #888;
        }

        .post-actions {
          display: flex;
          border-top: 1px solid rgba(255, 255, 255, 0.05);
          margin-top: 10px;
          padding: 10px 12px;
          gap: 8px;
        }

        .post-action-btn {
          flex: 1;
          background: transparent;
          border: none;
          color: #ddd;
          padding: 10px;
          border-radius: 10px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          font-weight: 600;
        }

        .post-action-btn:hover {
          background: rgba(255, 255, 255, 0.05);
        }

        .active-reaction {
          color: #fff !important;
          background: rgba(255, 51, 51, 0.12) !important;
        }

        .reaction-area {
          position: relative;
          flex: 1;
        }

        .reaction-picker {
          position: absolute;
          bottom: calc(100% + 8px);
          left: 12px;
          background: #1a0000;
          border: 1px solid rgba(255, 0, 0, 0.25);
          border-radius: 999px;
          padding: 8px 10px;
          display: flex;
          gap: 8px;
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
          z-index: 50;
        }

        .reaction-option {
          background: transparent;
          border: none;
          font-size: 24px;
          cursor: pointer;
          transition: transform 0.15s ease;
        }

        .reaction-option:hover {
          transform: scale(1.2);
        }

        .comments-section {
          padding: 14px 20px 18px;
        }

        .comments-list {
          display: flex;
          flex-direction: column;
          gap: 12px;
          margin-bottom: 12px;
        }

        .comment-item {
          display: flex;
          gap: 10px;
        }

        .comment-item.reply {
          margin-left: 26px;
        }

        .comment-avatar {
          width: 36px;
          height: 36px;
          flex-shrink: 0;
        }

        .comment-content {
          flex: 1;
          min-width: 0;
        }

        .comment-header {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 4px;
        }

        .comment-author {
          font-weight: 700;
          font-size: 14px;
        }

        .comment-time {
          font-size: 12px;
          color: #888;
        }

        .comment-text {
          color: #eee;
          font-size: 14px;
          white-space: pre-wrap;
        }

        .comment-actions {
          display: flex;
          gap: 8px;
          margin-top: 6px;
          flex-wrap: wrap;
        }

        .comment-action-btn {
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid rgba(255, 255, 255, 0.06);
          color: #ddd;
          border-radius: 8px;
          padding: 4px 8px;
          cursor: pointer;
          font-size: 12px;
        }

        .reply-input-container {
          margin-top: 8px;
          display: flex;
          gap: 8px;
        }

        .reply-input-container input,
        .comment-input {
          flex: 1;
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid rgba(255, 255, 255, 0.06);
          color: #fff;
          border-radius: 10px;
          padding: 10px 12px;
          outline: none;
        }

        .send-reply-btn,
        .comment-submit-btn {
          border: none;
          background: linear-gradient(45deg, #ff3333, #ff6666);
          color: white;
          border-radius: 10px;
          cursor: pointer;
          padding: 0 14px;
        }

        .replies-container {
          margin-top: 10px;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }

        .add-comment-form {
          margin-top: 12px;
        }

        .comment-input-wrapper {
          display: flex;
          gap: 10px;
          align-items: center;
        }

        .comment-avatar-small {
          width: 34px;
          height: 34px;
          flex-shrink: 0;
        }

        .comment-input-group {
          flex: 1;
          display: flex;
          gap: 8px;
        }

        .no-comments,
        .view-all-comments {
          color: #999;
          font-size: 13px;
          background: none;
          border: none;
          text-align: left;
        }

        .profile-header {
          display: flex;
          align-items: center;
          gap: 14px;
          margin-bottom: 16px;
        }

        .profile-avatar {
          width: 64px;
          height: 64px;
        }

        .profile-name {
          font-size: 18px;
          font-weight: 700;
        }

        .profile-email {
          color: #aaa;
          font-size: 13px;
        }

        .profile-stats {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 10px;
        }

        .profile-stat {
          background: rgba(255, 255, 255, 0.04);
          border-radius: 12px;
          padding: 12px;
          text-align: center;
        }

        .stat-value {
          font-size: 20px;
          font-weight: 800;
          color: #ff6666;
        }

        .stat-label {
          font-size: 12px;
          color: #aaa;
        }

        .avatar-placeholder {
          width: 100%;
          height: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
          background: linear-gradient(45deg, #ff3333, #ff6666);
          color: white;
          font-weight: 700;
        }

        .avatar-placeholder.small {
          font-size: 12px;
        }

        .avatar-placeholder.large {
          font-size: 22px;
        }

        @media (max-width: 1200px) {
          .main-content {
            grid-template-columns: 280px 1fr;
          }

          .right-sidebar {
            display: none;
          }
        }

        @media (max-width: 768px) {
          .main-content {
            grid-template-columns: 1fr;
            padding: 0 16px 30px;
          }

          .left-sidebar {
            display: none;
          }

          .header {
            padding: 0 12px;
          }

          .header-left {
            width: auto;
          }

          .header-center {
            display: none;
          }

          .header-right {
            width: auto;
          }

          .notification-dropdown {
            width: 300px;
            right: -40px;
          }
        }
      `}</style>
    </>
  );
}