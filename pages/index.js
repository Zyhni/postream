import Head from 'next/head';
import { useEffect, useState, useRef, useMemo } from 'react';
import { initFirebaseClient, getAuthInstance, getDbInstance } from '../lib/firebaseClient';
import { GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from 'firebase/auth';
import { 
  collection, 
  addDoc, 
  query, 
  orderBy, 
  getDocs, 
  serverTimestamp
} from 'firebase/firestore';

export default function Home() {
  const [initialized, setInitialized] = useState(false);
  const [user, setUser] = useState(null);
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [uploads, setUploads] = useState([]);
  const [commentText, setCommentText] = useState({});
  const [replyText, setReplyText] = useState({});
  const [comments, setComments] = useState({});
  const [showReplyInput, setShowReplyInput] = useState({});
  const [expandedReplies, setExpandedReplies] = useState({});
  const [uploading, setUploading] = useState(false);
  const [postCaption, setPostCaption] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const authRef = useRef(null);
  const dbRef = useRef(null);
  const provider = new GoogleAuthProvider();

  // INIT FIREBASE
  useEffect(() => {
    const init = async () => {
      await initFirebaseClient();
      authRef.current = getAuthInstance();
      dbRef.current = getDbInstance();
      setInitialized(true);
      
      if (authRef.current) {
        const unsubscribe = onAuthStateChanged(authRef.current, (u) => {
          setUser(u || null);
        });
        return () => unsubscribe();
      }
    };
    
    init();
  }, []);

  // LOAD RECENT POSTS
  useEffect(() => {
    if (initialized) loadRecent();
  }, [initialized]);

  async function loadRecent() {
    try {
      const q = query(collection(dbRef.current, 'uploads'), orderBy('createdAt', 'desc'));
      const snap = await getDocs(q);
      const posts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      setUploads(posts);

      // LOAD COMMENTS FOR EACH POST
      const commentsData = {};
      for (const post of posts) {
        try {
          const cQ = query(collection(dbRef.current, `uploads/${post.id}/comments`), orderBy('createdAt', 'asc'));
          const cSnap = await getDocs(cQ);
          const postComments = cSnap.docs.map(c => ({ 
            id: c.id, 
            ...c.data(),
            replies: []
          }));
          
          const commentMap = {};
          const rootComments = [];
          
          postComments.forEach(comment => {
            commentMap[comment.id] = { ...comment };
          });
          
          postComments.forEach(comment => {
            if (comment.parentId) {
              if (commentMap[comment.parentId]) {
                if (!commentMap[comment.parentId].replies) {
                  commentMap[comment.parentId].replies = [];
                }
                commentMap[comment.parentId].replies.push(comment);
              }
            } else {
              rootComments.push(comment);
            }
          });
          
          commentsData[post.id] = rootComments;
        } catch (commentError) {
          console.error("Error loading comments for post", post.id, commentError);
        }
      }

      setComments(commentsData);

    } catch (e) {
      console.error("load error:", e);
    }
  }

  // SUBMIT COMMENT
  async function handleCommentSubmit(postId, parentId = null) {
    const text = parentId ? replyText[`${postId}-${parentId}`] : commentText[postId];
    if (!text || !user) return;

    const commentData = {
      uid: user.uid,
      name: user.displayName,
      avatar: user.photoURL || "",
      text,
      createdAt: serverTimestamp(),
      likes: 0,
      parentId: parentId || null
    };

    try {
      await addDoc(collection(dbRef.current, `uploads/${postId}/comments`), commentData);

      if (parentId) {
        setReplyText(prev => ({ ...prev, [`${postId}-${parentId}`]: "" }));
        setShowReplyInput(prev => ({ ...prev, [`${postId}-${parentId}`]: false }));
      } else {
        setCommentText(prev => ({ ...prev, [postId]: "" }));
      }

      await loadRecent();
    } catch (e) {
      console.error("Error submitting comment:", e);
      alert("Failed to submit comment: " + e.message);
    }
  }

  // TOGGLES
  function toggleReplyInput(postId, commentId) {
    setShowReplyInput(prev => ({
      ...prev,
      [`${postId}-${commentId}`]: !prev[`${postId}-${commentId}`]
    }));
  }

  function toggleReplies(postId, commentId) {
    setExpandedReplies(prev => ({
      ...prev,
      [`${postId}-${commentId}`]: !prev[`${postId}-${commentId}`]
    }));
  }

  // UPLOAD HANDLER (file(s) + caption)
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
              "Authorization": `Bearer ${token}`
            },
            body: JSON.stringify({ folder: `user_${user.uid}` })
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
          
          const uploadRes = await fetch(cloudinaryUrl, { 
            method: "POST", 
            body: form 
          });
          
          if (!uploadRes.ok) {
            throw new Error(`Cloudinary upload failed: ${uploadRes.status}`);
          }
          
          const uploadJson = await uploadRes.json();

          if (uploadJson.secure_url) {
            await addDoc(collection(dbRef.current, 'uploads'), {
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
              commentsCount: 0
            });
          } else {
            throw new Error("No secure_url in response");
          }
          
          if (i < selectedFiles.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 500));
          }
          
        } catch (fileError) {
          console.error(`Error uploading file ${f.name}:`, fileError);
          alert(`Failed to upload ${f.name}: ${fileError.message}`);
        }
      }

      // clear selection + caption, reload
      setSelectedFiles([]);
      setPostCaption("");
      await loadRecent();
      alert("Upload completed successfully!");
      setShowUploadModal(false);
      
    } catch (e) {
      console.error("Upload error:", e);
      alert("Upload failed: " + e.message);
    } finally {
      setUploading(false);
    }
  }

  // POST CAPTION ONLY (no file)
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
      await addDoc(collection(dbRef.current, 'uploads'), {
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
        commentsCount: 0
      });

      setPostCaption("");
      await loadRecent();
      alert("Post created!");
      setShowUploadModal(false);
    } catch (e) {
      console.error("Failed to create caption post:", e);
      alert("Failed to post caption: " + (e.message || String(e)));
    } finally {
      setUploading(false);
    }
  }

  // NEW unified handler
  async function handleCreatePost() {
    // require user
    if (!user) {
      alert('Please login first!');
      return;
    }
    // if files exist -> upload files (each will use postCaption)
    if (selectedFiles.length > 0) {
      await handleUploadAll();
      return;
    }
    // else if caption exists -> caption-only
    if (postCaption?.trim()) {
      await handlePostCaptionOnly();
      return;
    }
    alert('Nothing to post. Add a caption or select files.');
  }

  // LOGIN / LOGOUT
  async function handleLogin() {
    try {
      if (!authRef.current) {
        await initFirebaseClient();
        authRef.current = getAuthInstance();
      }
      
      provider.addScope('profile');
      provider.addScope('email');
      
      const result = await signInWithPopup(authRef.current, provider);
      setUser(result.user);
      
    } catch (error) {
      console.error("Login error:", error);
      
      if (error.code === 'auth/popup-blocked') {
        alert('Popup was blocked by your browser. Please allow popups for this site.');
      } else if (error.code === 'auth/popup-closed-by-user') {
        console.log('Popup closed by user');
      } else {
        alert('Login error: ' + error.message);
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

  // FORMAT TIME
  function formatTimeAgo(timestamp) {
    if (!timestamp) return 'Just now';
    try {
      const date = timestamp.toDate();
      const now = new Date();
      const diff = now - date;
      const minutes = Math.floor(diff / 60000);
      const hours = Math.floor(minutes / 60);
      const days = Math.floor(hours / 24);
      
      if (days > 0) return `${days}d ago`;
      if (hours > 0) return `${hours}h ago`;
      if (minutes > 0) return `${minutes}m ago`;
      return 'Just now';
    } catch (e) {
      return 'Recently';
    }
  }

  // DOWNLOAD HANDLER
  async function handleDownload(post) {
    if (!post || !post.url) {
      alert("No file to download.");
      return;
    }
    try {
      const res = await fetch(post.url, { mode: 'cors' });
      if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
      const blob = await res.blob();
      let filename = post.fileName || post.public_id || 'download';
      if (post.format && !filename.toLowerCase().endsWith('.' + post.format.toLowerCase())) {
        filename = `${filename}.${post.format}`;
      } else {
        if (!/\.[a-zA-Z0-9]{1,6}$/.test(filename)) {
          const urlName = post.url.split('?')[0].split('/').pop();
          if (urlName) filename = urlName;
        }
      }
      const link = document.createElement('a');
      const url = URL.createObjectURL(blob);
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Download failed, opening in new tab", err);
      window.open(post.url, '_blank');
    }
  }

  // RENDER COMMENT WITH REPLIES
  function renderComment(comment, postId, depth = 0) {
    const hasReplies = comment.replies && comment.replies.length > 0;
    const isExpanded = expandedReplies[`${postId}-${comment.id}`];
    
    return (
      <div key={comment.id} className={`comment-item ${depth > 0 ? 'reply' : ''}`}>
        <div className="comment-avatar">
          {comment.avatar ? (
            <img src={comment.avatar} alt={comment.name} />
          ) : (
            <div className="avatar-placeholder">
              {comment.name?.charAt(0) || 'U'}
            </div>
          )}
        </div>
        <div className="comment-content">
          <div className="comment-header">
            <span className="comment-author">{comment.name}</span>
            <span className="comment-time">{formatTimeAgo(comment.createdAt)}</span>
          </div>
          <div className="comment-text">{comment.text}</div>
          <div className="comment-actions">
            <button 
              className="comment-action-btn"
              onClick={() => toggleReplyInput(postId, comment.id)}
            >
              <span className="reply-icon">↩️</span> Reply
            </button>
            {hasReplies && (
              <button 
                className="comment-action-btn"
                onClick={() => toggleReplies(postId, comment.id)}
              >
                <span className="replies-icon">💬</span> 
                {isExpanded ? 'Hide' : 'Show'} replies ({comment.replies.length})
              </button>
            )}
          </div>
          
          {/* Reply input */}
          {showReplyInput[`${postId}-${comment.id}`] && (
            <div className="reply-input-container">
              <input
                type="text"
                placeholder="Write a reply..."
                value={replyText[`${postId}-${comment.id}`] || ""}
                onChange={e => setReplyText(prev => ({ 
                  ...prev, 
                  [`${postId}-${comment.id}`]: e.target.value 
                }))}
                onKeyDown={(e) => e.key === 'Enter' && handleCommentSubmit(postId, comment.id)}
              />
              <button 
                className="send-reply-btn"
                onClick={() => handleCommentSubmit(postId, comment.id)}
              >
                Send
              </button>
            </div>
          )}
          
          {/* Nested replies */}
          {hasReplies && isExpanded && (
            <div className="replies-container">
              {comment.replies.map(reply => renderComment(reply, postId, depth + 1))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // filtered uploads based on header search (case-insensitive match on caption/text)
  const filteredUploads = useMemo(() => {
    if (!searchQuery?.trim()) return uploads;
    const q = searchQuery.trim().toLowerCase();
    return uploads.filter(p => (p.text || "").toLowerCase().includes(q));
  }, [uploads, searchQuery]);

  // small helper: upload panel extracted so we can reuse in modal on mobile
  function UploadPanel({ compact = false }) {
    return (
      <div className="upload-section">
        <div className="section-header">
          <i className="fas fa-cloud-upload-alt"></i>
          <h3>Upload Content</h3>
        </div>
        <div className="file-upload-area">
          <textarea
            placeholder="Caption..."
            value={postCaption}
            onChange={e => setPostCaption(e.target.value)}
            rows={compact ? 2 : 3}
            style={{
              width: '100%',
              borderRadius: 8,
              padding: 10,
              resize: 'vertical',
              background: 'rgba(255,255,255,0.03)',
              color: '#fff',
              border: '1px solid rgba(255,51,51,0.15)'
            }}
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
              accept="image/*,video/*"
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
                {selectedFiles.slice(0, 3).map((file, idx) => (
                  <div key={idx} className="file-preview-item">
                    <i className={file.type.startsWith('image/') ? "fas fa-image" : "fas fa-video"}></i>
                    <span className="file-name">{file.name}</span>
                    <span className="file-size">({(file.size / 1024 / 1024).toFixed(1)} MB)</span>
                  </div>
                ))}
                {selectedFiles.length > 3 && (
                  <div className="more-files-count">
                    +{selectedFiles.length - 3} more files
                  </div>
                )}
              </div>
            </div>
          )}
          
          <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
            <button 
              className={`upload-action-btn ${uploading ? 'uploading' : ''}`}
              onClick={handleCreatePost}
              disabled={uploading || (selectedFiles.length === 0 && !postCaption.trim())}
              aria-disabled={uploading || (selectedFiles.length === 0 && !postCaption.trim())}
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
      </div>
    );
  }

  return (
    <>
      <Head>
        <title>POSTREAM</title>
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      </Head>

      <div className="layout">
        {/* HEADER */}
        <header className="header">
          <div className="header-left">
            <button className="mobile-menu-btn" onClick={() => setMobileMenuOpen(prev => !prev)} aria-label="Open menu">
              <i className="fas fa-bars"></i>
            </button>
            <div className="logo">
              <i className="fas fa-fire logo-icon"></i>
              <span>POSTREAM</span>
            </div>
          </div>

          {/* SEARCH (center) */}
          <div className="header-center">
            <input
              type="search"
              placeholder="Search captions..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="search-input"
            />
          </div>
          
          <div className="header-right">
            {!user ? (
              <button className="login-btn" onClick={handleLogin}>
                <i className="fab fa-google"></i> Login
              </button>
            ) : (
              <div className="user-info-header">
                <div className="user-avatar-header">
                  {user.photoURL ? (
                    <img src={user.photoURL} alt={user.displayName} />
                  ) : (
                    <div className="avatar-placeholder">
                      {user.displayName?.charAt(0) || 'U'}
                    </div>
                  )}
                </div>
                <button className="logout-btn" onClick={handleLogout} title="Logout">
                  <i className="fas fa-sign-out-alt"></i>
                </button>
              </div>
            )}
          </div>
        </header>

        {/* MOBILE OVERLAY SIDEBAR (when hamburger clicked) */}
        {mobileMenuOpen && (
          <div className="mobile-overlay" onClick={() => setMobileMenuOpen(false)}>
            <div className="mobile-drawer" onClick={e => e.stopPropagation()}>
              {user ? (
                <div className="mobile-drawer-inner">
                  <div className="profile-card mobile">
                    <div className="profile-header">
                      <div className="profile-avatar">
                        {user.photoURL ? (
                          <img src={user.photoURL} alt={user.displayName} />
                        ) : (
                          <div className="avatar-placeholder large">{user.displayName?.charAt(0) || 'U'}</div>
                        )}
                      </div>
                      <div className="profile-info">
                        <div className="profile-name">{user.displayName}</div>
                        <div className="profile-email">{user.email}</div>
                      </div>
                    </div>
                    <div style={{ padding: 16 }}>
                      <div className="profile-stat">
                        <div className="stat-value">{uploads.filter(u => u.ownerUid === user.uid).length}</div>
                        <div className="stat-label">Posts</div>
                      </div>
                    </div>
                  </div>

                  <div style={{ padding: 12 }}>
                    <UploadPanel compact />
                  </div>
                </div>
              ) : (
                <div style={{ padding: 16 }}>
                  <button className="login-btn" onClick={handleLogin} style={{ width: '100%' }}>Login with Google</button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* MAIN CONTENT */}
        <main className="main-content">
          {/* LEFT SIDEBAR */}
          <aside className="sidebar left-sidebar">
            {user && <UploadPanel />}
          </aside>

          {/* MAIN FEED */}
          <section className="main-feed">
            {filteredUploads.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon">
                  <i className="fas fa-stream"></i>
                </div>
                <h3>Welcome to POSTREAM</h3>
                <p>{user ? 'No posts match your search.' : 'Login to start sharing content'}</p>
                {!user && (
                  <button className="empty-state-btn" onClick={handleLogin}>
                    <i className="fab fa-google"></i> Get Started
                  </button>
                )}
              </div>
            ) : (
              filteredUploads.map(post => (
                <article key={post.id} className="post-card">
                  {/* POST HEADER */}
                  <div className="post-header">
                    <div className="post-author-info">
                      <div className="post-avatar">
                        {post.ownerPhoto ? (
                          <img src={post.ownerPhoto} alt={post.ownerName} />
                        ) : (
                          <div className="avatar-placeholder">{post.ownerName?.charAt(0) || 'U'}</div>
                        )}
                      </div>
                      <div className="author-details">
                        <div className="author-name">{post.ownerName}</div>
                        <div className="post-time">{formatTimeAgo(post.createdAt)}</div>
                      </div>
                    </div>

                    {/* DOWNLOAD BUTTON (replaces three-dots) */}
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

                  {/* POST CAPTION */}
                  {post.text && (
                    <div className="post-caption">
                      {post.text}
                    </div>
                  )}

                  {/* POST MEDIA */}
                  {post.url && (
                    <div className="post-media-container">
                      {post.resource_type === "image" ? (
                        <img 
                          src={post.url} 
                          className="post-media-image" 
                          alt={post.fileName} 
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

                  {/* POST ACTIONS */}
                  <div className="post-actions">
                    <button className="post-action-btn" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>
                      <i className="far fa-comment"></i>
                      <span>Comment</span>
                    </button>
                  </div>

                  {/* COMMENTS SECTION */}
                  <div className="comments-section">
                    {/* Comments list */}
                    <div className="comments-list">
                      {comments[post.id]?.slice(0, 2).map(comment => renderComment(comment, post.id))}
                      {(!comments[post.id] || comments[post.id].length === 0) && (
                        <div className="no-comments">No comments yet</div>
                      )}
                      {comments[post.id] && comments[post.id].length > 2 && (
                        <button className="view-all-comments">
                          View all {comments[post.id].length} comments
                        </button>
                      )}
                    </div>

                    {/* Add comment */}
                    {user && (
                      <div className="add-comment-form">
                        <div className="comment-input-wrapper">
                          <div className="comment-avatar-small">
                            {user.photoURL ? (
                              <img src={user.photoURL} alt={user.displayName} />
                            ) : (
                              <div className="avatar-placeholder small">{user.displayName?.charAt(0) || 'U'}</div>
                            )}
                          </div>
                          <div className="comment-input-group">
                            <input
                              type="text"
                              placeholder="Write a comment..."
                              value={commentText[post.id] || ""}
                              onChange={e => setCommentText(prev => ({ ...prev, [post.id]: e.target.value }))}
                              onKeyDown={(e) => e.key === 'Enter' && handleCommentSubmit(post.id)}
                              className="comment-input"
                            />
                            <button 
                              className="comment-submit-btn"
                              onClick={() => handleCommentSubmit(post.id)}
                              disabled={!commentText[post.id]?.trim()}
                            >
                              <i className="fas fa-paper-plane"></i>
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </article>
              ))
            )}
          </section>

          {/* RIGHT SIDEBAR */}
          <aside className="sidebar right-sidebar">
            {user && (
              <div className="profile-card">
                <div className="profile-header">
                  <div className="profile-avatar">
                    {user.photoURL ? (
                      <img src={user.photoURL} alt={user.displayName} />
                    ) : (
                      <div className="avatar-placeholder large">{user.displayName?.charAt(0) || 'U'}</div>
                    )}
                  </div>
                  <div className="profile-info">
                    <div className="profile-name">{user.displayName}</div>
                    <div className="profile-email">{user.email}</div>
                  </div>
                </div>
                
                <div className="profile-stats">
                  <div className="profile-stat">
                    <div className="stat-value">{uploads.filter(u => u.ownerUid === user.uid).length}</div>
                    <div className="stat-label">Posts</div>
                  </div>
                  <div className="profile-stat">
                    <div className="stat-value">
                      {Object.values(comments).flat().filter(c => c && c.uid === user.uid).length}
                    </div>
                    <div className="stat-label">Comments</div>
                  </div>
                </div>
              </div>
            )}
          </aside>
        </main>

        {/* FLOATING FAB for mobile to open upload modal */}
        <button className="upload-fab" onClick={() => setShowUploadModal(true)} aria-label="Open upload">
          <i className="fas fa-plus"></i>
        </button>

        {/* Upload modal for mobile */}
        {showUploadModal && (
          <div className="upload-modal" onClick={() => setShowUploadModal(false)}>
            <div className="upload-modal-inner" onClick={e => e.stopPropagation()}>
              <div className="upload-modal-header">
                <h3>Create Post</h3>
                <button className="close-modal-btn" onClick={() => setShowUploadModal(false)} aria-label="Close">✕</button>
              </div>
              <div className="upload-modal-body">
                <UploadPanel compact />
              </div>
            </div>
          </div>
        )}
      </div>

      <style jsx global>{`
       {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }

        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
          background: #0a0a0a;
          color: #fff;
          line-height: 1.5;
          overflow-x: hidden;
          -webkit-font-smoothing: antialiased;
          -webkit-tap-highlight-color: transparent;
        }

        /* HEADER */
        .header { position: fixed; top: 0; left: 0; right: 0; height: 60px; background: linear-gradient(90deg,#1a0000 0%,#330000 100%); border-bottom: 1px solid rgba(255,0,0,0.2); display:flex; align-items:center; padding:0 16px; z-index:1000; }
        .header-left { display:flex; align-items:center; width: 240px; gap:8px; }
        .mobile-menu-btn { display:none; background:transparent; border:none; color:#ff6666; font-size:20px; width:40px; height:40px; border-radius:8px; }
        .logo { display:flex; align-items:center; gap:10px; font-size:20px; font-weight:800; background: linear-gradient(45deg,#ff3333,#ff6666); -webkit-background-clip:text; -webkit-text-fill-color:transparent; }
        .header-center { flex: 1; display:flex; justify-content:center; }
        .search-input { width: 60%; max-width: 520px; min-width: 180px; padding: 8px 12px; border-radius: 18px; border: 1px solid rgba(255,255,255,0.06); background: rgba(255,255,255,0.02); color: #fff; outline: none; }
        .search-input::placeholder { color: #bbb; }
        .header-right { display:flex; align-items:center; gap:12px; width: 260px; justify-content:flex-end; }

        .login-btn {
          background: linear-gradient(45deg, #ff3333, #ff6666);
          border: none;
          padding: 8px 12px;
          border-radius: 8px;
          color: white;
          font-weight: 600;
          cursor: pointer;
          display: flex;
          align-items: center;
          gap: 8px;
          transition: all 0.3s ease;
          font-size: 13px;
        }

        .user-info-header {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .user-avatar-header {
          width: 36px;
          height: 36px;
          border-radius: 50%;
          overflow: hidden;
          border: 2px solid #ff3333;
        }

        .user-avatar-header img {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }

        .logout-btn {
          background: rgba(255, 0, 0, 0.1);
          border: 1px solid rgba(255, 0, 0, 0.3);
          color: #ff6666;
          width: 36px;
          height: 36px;
          border-radius: 8px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.3s ease;
        }

        .logout-btn:hover { background: rgba(255,0,0,0.16); }

        /* MAIN LAYOUT */
        .main-content {
          display: grid;
          grid-template-columns: 320px 1fr 320px;
          gap: 24px;
          max-width: 1400px;
          margin: 80px auto 0;
          padding: 0 24px 40px;
          min-height: calc(100vh - 60px);
        }

        @media (max-width: 1200px) {
          .main-content { grid-template-columns: 280px 1fr; }
          .right-sidebar { display: none; }
        }

        @media (max-width: 900px) {
          .header { padding: 0 12px; }
          .header-left { width: auto; }
          .mobile-menu-btn { display: inline-flex; align-items:center; justify-content:center; }
          .search-input { width: 70%; }
        }

        @media (max-width: 768px) {
          .main-content { grid-template-columns: 1fr; padding: 0 12px; }
          .left-sidebar { display: none; }
          .header-center { display: none; }
          .header-right { width: auto; }
          .logo { font-size: 18px; }

          /* FAB */
          .upload-fab { display: flex; }
        }

        /* MOBILE OVERLAY */
        .mobile-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 1200; display:flex; }
        .mobile-drawer { width: 320px; max-width: 92%; background: rgba(10,10,10,0.98); padding: 12px; overflow:auto; }

        /* LEFT SIDEBAR */
        .sidebar { position: sticky; top: 80px; height: fit-content; }

        /* LEFT SIDEBAR */
        .upload-section {
          background: rgba(26, 0, 0, 0.8);
          border: 1px solid rgba(255, 0, 0, 0.2);
          border-radius: 16px;
          padding: 16px;
          margin-bottom: 20px;
          backdrop-filter: blur(10px);
        }

        .section-header { display:flex; align-items:center; gap:10px; margin-bottom:12px; }
        .section-header i { color: #ff3333; font-size: 18px; }
        .section-header h3 { font-size: 16px; color:white; margin:0; }

        .file-input-label { display:flex; align-items:center; gap:12px; padding:12px; background: rgba(255, 51, 51, 0.03); border: 2px dashed rgba(255, 51, 51, 0.12); border-radius: 10px; cursor:pointer; }
        .file-input-icon { width:40px; height:40px; display:flex; align-items:center; justify-content:center; border-radius:8px; background: rgba(255,51,51,0.06); }

        .file-input { display:none; }

        .selected-files-list { background: rgba(0,0,0,0.22); border-radius:10px; padding:10px; }
        .files-preview { display:flex; flex-direction:column; gap:8px; }
        .file-preview-item { display:flex; align-items:center; gap:8px; padding:8px; background: rgba(255,255,255,0.03); border-radius:8px; font-size:13px; }
        .file-name { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

        .upload-action-btn { width:100%; background: linear-gradient(45deg, #ff3333, #ff6666); border:none; padding:12px; border-radius:10px; color:white; font-weight:700; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:8px; }

        .upload-action-btn:disabled { opacity:0.6; cursor:not-allowed; }

        /* POST CARD */
        .post-card { background: rgba(26, 0, 0, 0.8); border: 1px solid rgba(255, 0, 0, 0.12); border-radius:12px; overflow:hidden; backdrop-filter: blur(6px); }
        .post-header { display:flex; justify-content:space-between; align-items:center; padding:12px; border-bottom:1px solid rgba(255,255,255,0.03); }
        .post-avatar { width:44px; height:44px; border-radius:50%; overflow:hidden; border:2px solid #ff3333; }
        .avatar-placeholder { width:100%; height:100%; display:flex; align-items:center; justify-content:center; color:white; font-weight:700; }

        .post-media-container { width:100%; max-height:640px; overflow:hidden; background:#000; display:flex; align-items:center; justify-content:center; }
        .post-media-image { width:100%; height:auto; max-height:640px; object-fit:contain; display:block; }
        .post-media-video { width:100%; max-height:640px; height:auto; }

        .post-actions { display:flex; padding:10px; border-top:1px solid rgba(255,255,255,0.03); border-bottom:1px solid rgba(255,255,255,0.03); }
        .post-action-btn { flex:1; background:none; border:none; color:#ddd; cursor:pointer; padding:8px; border-radius:8px; display:flex; align-items:center; justify-content:center; gap:6px; }

        /* COMMENTS */
        .comments-section { padding:12px; }
        .comment-item { display:flex; gap:12px; margin-bottom:12px; }
        .comment-item.reply { margin-left:36px; }
        .comment-avatar { width:36px; height:36px; border-radius:50%; overflow:hidden; }
        .comment-content { flex:1; }
        .comment-author { font-weight:700; color:white; font-size:14px; }
        .comment-text { color:#ccc; font-size:14px; }

        .reply-input-container input { padding:8px 12px; border-radius:20px; border:1px solid rgba(255,51,51,0.12); background:rgba(255,255,255,0.03); color:white; }

        /* ADD COMMENT FORM */
        .add-comment-form { margin-top:12px; }
        .comment-input-wrapper { display:flex; align-items:center; gap:8px; }
        .comment-input-group { flex:1; display:flex; gap:8px; align-items:center; background: rgba(255,255,255,0.02); padding:6px 8px; border-radius:24px; }
        .comment-input { flex:1; background:none; border:none; color:white; outline:none; padding:8px; }
        .comment-submit-btn { width:36px; height:36px; border-radius:50%; display:flex; align-items:center; justify-content:center; border:none; background:linear-gradient(45deg,#ff3333,#ff6666); color:white; }

        /* PROFILE CARD */
        .profile-card { background: rgba(26, 0, 0, 0.8); border-radius:12px; padding:16px; }

        /* FAB */
        .upload-fab { position: fixed; right: 16px; bottom: 18px; width:56px; height:56px; border-radius:50%; background:linear-gradient(45deg,#ff3333,#ff6666); display:none; align-items:center; justify-content:center; border:none; z-index:1400; box-shadow:0 8px 24px rgba(0,0,0,0.5); color:white; font-size:20px; }

        /* UPLOAD MODAL */
        .upload-modal { position:fixed; inset:0; background: rgba(0,0,0,0.6); display:flex; align-items:flex-end; z-index:1500; }
        .upload-modal-inner { width:100%; max-height:86vh; border-top-left-radius:12px; border-top-right-radius:12px; background: rgba(10,10,10,0.98); padding:12px; }
        .upload-modal-header { display:flex; justify-content:space-between; align-items:center; padding:8px 6px; }
        .upload-modal-body { padding:8px; overflow:auto; }
        .close-modal-btn { background:transparent; border:none; color:#fff; font-size:20px; }

        /* MOBILE specific touch targets */
        button, input[type="button"], input[type="submit"], .upload-action-btn { touch-action: manipulation; }

        /* small helpers */
        .empty-state { text-align:center; padding:40px 20px; border-radius:12px; }

        /* small animation for spinner */
        .fa-spin { animation: fa-spin 1s linear infinite; }
        @keyframes fa-spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
      `}</style>
    </>
  );
}
