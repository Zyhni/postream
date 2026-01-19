import Head from 'next/head';
import { useEffect, useState, useRef } from 'react';
import { initFirebaseClient, getAuthInstance, getDbInstance } from '../lib/firebaseClient';
import { GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from 'firebase/auth';
import { 
  collection, 
  addDoc, 
  query, 
  orderBy, 
  getDocs, 
  serverTimestamp,
  doc,
  updateDoc,
  arrayUnion
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

  // TOGGLE REPLY INPUT
  function toggleReplyInput(postId, commentId) {
    setShowReplyInput(prev => ({
      ...prev,
      [`${postId}-${commentId}`]: !prev[`${postId}-${commentId}`]
    }));
  }

  // TOGGLE REPLY VISIBILITY
  function toggleReplies(postId, commentId) {
    setExpandedReplies(prev => ({
      ...prev,
      [`${postId}-${commentId}`]: !prev[`${postId}-${commentId}`]
    }));
  }

  // UPLOAD HANDLER
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

      setSelectedFiles([]);
      await loadRecent();
      alert("Upload completed successfully!");
      
    } catch (e) {
      console.error("Upload error:", e);
      alert("Upload failed: " + e.message);
    } finally {
      setUploading(false);
    }
  }

  // LOGIN HANDLER
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

  // LOGOUT HANDLER
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

  // DOWNLOAD HANDLER: try to fetch blob and trigger download, else open in new tab
  async function handleDownload(post) {
    if (!post || !post.url) return;
    try {
      const res = await fetch(post.url, { mode: 'cors' });
      if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
      const blob = await res.blob();
      // determine filename
      let filename = post.fileName || post.public_id || 'download';
      // if format exists, ensure extension
      if (post.format && !filename.toLowerCase().endsWith('.' + post.format.toLowerCase())) {
        filename = `${filename}.${post.format}`;
      } else {
        // try to extract name from URL if no extension present
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
      // fallback: open source URL in new tab
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
                onKeyPress={(e) => e.key === 'Enter' && handleCommentSubmit(postId, comment.id)}
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

  return (
    <>
      <Head>
        <title>POSTREAM</title>
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <div className="layout">
        {/* HEADER */}
        <header className="header">
          <div className="header-left">
            <div className="logo">
              <i className="fas fa-fire logo-icon"></i>
              <span>POSTREAM</span>
            </div>
          </div>
          
          <div className="header-right">
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
                    <div className="avatar-placeholder">
                      {user.displayName?.charAt(0) || 'U'}
                    </div>
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

        {/* MAIN CONTENT */}
        <main className="main-content">
          {/* LEFT SIDEBAR */}
          <aside className="sidebar left-sidebar">
            {user && (
              <div className="upload-section">
                <div className="section-header">
                  <i className="fas fa-cloud-upload-alt"></i>
                  <h3>Upload Content</h3>
                </div>
                
                <div className="file-upload-area">
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
                            <i className={file.type.startsWith('image/') ? "fas fa-image" : "fas fa-video"}></i>
                            <span className="file-name">{file.name}</span>
                            <span className="file-size">({(file.size / 1024 / 1024).toFixed(1)} MB)</span>
                          </div>
                        ))}
                        {selectedFiles.length > 2 && (
                          <div className="more-files-count">
                            +{selectedFiles.length - 2} more files
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                  
                  <button 
                    className={`upload-action-btn ${uploading ? 'uploading' : ''}`}
                    onClick={handleUploadAll}
                    disabled={selectedFiles.length === 0 || uploading}
                  >
                    {uploading ? (
                      <>
                        <i className="fas fa-spinner fa-spin"></i>
                        Uploading...
                      </>
                    ) : (
                      <>
                        <i className="fas fa-upload"></i>
                        Upload Now
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}
          </aside>

          {/* MAIN FEED */}
          <section className="main-feed">
            {uploads.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon">
                  <i className="fas fa-stream"></i>
                </div>
                <h3>Welcome to POSTREAM</h3>
                <p>{user ? 'Share your first post!' : 'Login to start sharing content'}</p>
                {!user && (
                  <button className="empty-state-btn" onClick={handleLogin}>
                    <i className="fab fa-google"></i> Get Started
                  </button>
                )}
              </div>
            ) : (
              uploads.map(post => (
                <article key={post.id} className="post-card">
                  {/* POST HEADER */}
                  <div className="post-header">
                    <div className="post-author-info">
                      <div className="post-avatar">
                        {post.ownerPhoto ? (
                          <img src={post.ownerPhoto} alt={post.ownerName} />
                        ) : (
                          <div className="avatar-placeholder">
                            {post.ownerName?.charAt(0) || 'U'}
                          </div>
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
                    >
                      <i className="fas fa-download"></i>
                    </button>
                  </div>

                  {/* POST CONTENT */}
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
                    <button className="post-action-btn">
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
                              <div className="avatar-placeholder small">
                                {user.displayName?.charAt(0) || 'U'}
                              </div>
                            )}
                          </div>
                          <div className="comment-input-group">
                            <input
                              type="text"
                              placeholder="Write a comment..."
                              value={commentText[post.id] || ""}
                              onChange={e => setCommentText(prev => ({ ...prev, [post.id]: e.target.value }))}
                              onKeyPress={(e) => e.key === 'Enter' && handleCommentSubmit(post.id)}
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
                      <div className="avatar-placeholder large">
                        {user.displayName?.charAt(0) || 'U'}
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
      </div>

      <style jsx global>{`
        * {
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
        }

        /* HEADER */
        .header {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          height: 60px;
          background: linear-gradient(90deg, #1a0000 0%, #330000 100%);
          border-bottom: 1px solid rgba(255, 0, 0, 0.2);
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 0 24px;
          z-index: 1000;
          backdrop-filter: blur(10px);
        }

        .header-left {
          display: flex;
          align-items: center;
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

        .logo-icon {
          font-size: 28px;
        }

        .header-right {
          display: flex;
          align-items: center;
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
          transition: all 0.3s ease;
        }

        .login-btn:hover {
          transform: translateY(-2px);
          box-shadow: 0 4px 12px rgba(255, 51, 51, 0.3);
        }

        .user-info-header {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .user-avatar-header {
          width: 40px;
          height: 40px;
          border-radius: 50%;
          overflow: hidden;
          border: 2px solid #ff3333;
        }

        .user-avatar-header img {
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
          color: #00ff00;
        }

        .status-dot {
          width: 8px;
          height: 8px;
          background: #00ff00;
          border-radius: 50%;
          animation: pulse 2s infinite;
        }

        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
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

        .logout-btn:hover {
          background: rgba(255, 0, 0, 0.2);
        }

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
            padding: 0 16px;
          }
          .left-sidebar {
            display: none;
          }
        }

        /* SIDEBARS */
        .sidebar {
          position: sticky;
          top: 80px;
          height: fit-content;
        }

        /* LEFT SIDEBAR */
        .upload-section {
          background: rgba(26, 0, 0, 0.8);
          border: 1px solid rgba(255, 0, 0, 0.2);
          border-radius: 16px;
          padding: 20px;
          margin-bottom: 20px;
          backdrop-filter: blur(10px);
        }

        .section-header {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-bottom: 20px;
        }

        .section-header i {
          color: #ff3333;
          font-size: 20px;
        }

        .section-header h3 {
          font-size: 18px;
          color: white;
        }

        .file-upload-area {
          display: flex;
          flex-direction: column;
          gap: 16px;
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
          transition: all 0.3s ease;
        }

        .file-input-label:hover {
          background: rgba(255, 51, 51, 0.1);
          border-color: rgba(255, 51, 51, 0.5);
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

        .file-input-icon i {
          font-size: 24px;
          color: #ff3333;
        }

        .file-input-text {
          flex: 1;
        }

        .file-input-title {
          font-weight: 600;
          color: white;
          margin-bottom: 4px;
        }

        .file-input-subtitle {
          font-size: 13px;
          color: #888;
        }

        .file-input {
          display: none;
        }

        .selected-files-list {
          background: rgba(0, 0, 0, 0.3);
          border-radius: 12px;
          padding: 16px;
        }

        .selected-files-header {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 12px;
          font-size: 14px;
          color: #888;
        }

        .files-preview {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .file-preview-item {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 10px;
          background: rgba(255, 255, 255, 0.05);
          border-radius: 8px;
          font-size: 13px;
        }

        .file-preview-item i {
          color: #ff3333;
          width: 16px;
        }

        .file-name {
          flex: 1;
          color: white;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
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

        .upload-action-btn {
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
          transition: all 0.3s ease;
          font-size: 16px;
        }

        .upload-action-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .upload-action-btn:not(:disabled):hover {
          transform: translateY(-2px);
          box-shadow: 0 6px 20px rgba(255, 51, 51, 0.4);
        }

        .stats-section {
          background: rgba(26, 0, 0, 0.8);
          border: 1px solid rgba(255, 0, 0, 0.2);
          border-radius: 16px;
          padding: 20px;
          backdrop-filter: blur(10px);
        }

        .stats-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 15px;
        }

        .stat-card {
          text-align: center;
          padding: 20px;
          background: rgba(255, 51, 51, 0.1);
          border-radius: 12px;
          border: 1px solid rgba(255, 51, 51, 0.2);
        }

        .stat-number {
          font-size: 32px;
          font-weight: 800;
          color: #ff3333;
          margin-bottom: 4px;
        }

        .stat-label {
          font-size: 13px;
          color: #888;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        /* MAIN FEED */
        .main-feed {
          display: flex;
          flex-direction: column;
          gap: 20px;
        }

        .empty-state {
          text-align: center;
          padding: 60px 40px;
          background: rgba(26, 0, 0, 0.8);
          border: 1px solid rgba(255, 0, 0, 0.2);
          border-radius: 16px;
          backdrop-filter: blur(10px);
        }

        .empty-state-icon {
          font-size: 64px;
          color: #ff3333;
          opacity: 0.5;
          margin-bottom: 20px;
        }

        .empty-state h3 {
          font-size: 24px;
          margin-bottom: 10px;
          color: white;
        }

        .empty-state p {
          color: #888;
          margin-bottom: 30px;
        }

        .empty-state-btn {
          background: linear-gradient(45deg, #ff3333, #ff6666);
          border: none;
          padding: 12px 30px;
          border-radius: 8px;
          color: white;
          font-weight: 600;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          gap: 10px;
          transition: all 0.3s ease;
        }

        .empty-state-btn:hover {
          transform: translateY(-2px);
          box-shadow: 0 4px 12px rgba(255, 51, 51, 0.3);
        }

        /* POST CARD */
        .post-card {
          background: rgba(26, 0, 0, 0.8);
          border: 1px solid rgba(255, 0, 0, 0.2);
          border-radius: 16px;
          overflow: hidden;
          backdrop-filter: blur(10px);
        }

        .post-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 20px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.05);
        }

        .post-author-info {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .post-avatar {
          width: 48px;
          height: 48px;
          border-radius: 50%;
          overflow: hidden;
          border: 2px solid #ff3333;
        }

        .post-avatar img {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }

        .avatar-placeholder {
          width: 100%;
          height: 100%;
          background: linear-gradient(45deg, #ff3333, #ff6666);
          display: flex;
          align-items: center;
          justify-content: center;
          color: white;
          font-weight: bold;
        }

        .avatar-placeholder.small {
          font-size: 14px;
        }

        .avatar-placeholder.large {
          font-size: 24px;
        }

        .author-details {
          display: flex;
          flex-direction: column;
        }

        .author-name {
          font-weight: 600;
          color: white;
        }

        .post-time {
          font-size: 13px;
          color: #888;
        }

        .post-menu-btn {
          background: none;
          border: none;
          color: #888;
          width: 36px;
          height: 36px;
          border-radius: 8px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.3s ease;
        }

        /* download button has same base style but show download hover */
        .download-btn:hover {
          background: rgba(255, 255, 255, 0.03);
          color: #fff;
        }

        .post-menu-btn:hover {
          background: rgba(255, 255, 255, 0.05);
          color: white;
        }

        .post-caption {
          padding: 0 20px 20px;
          color: white;
          font-size: 15px;
          line-height: 1.5;
        }

        .post-media-container {
          width: 100%;
          max-height: 600px;
          overflow: hidden;
          background: #000;
        }

        .post-media-image {
          width: 100%;
          max-height: 600px;
          object-fit: contain;
          display: block;
        }

        .post-media-video {
          width: 100%;
          max-height: 600px;
          display: block;
        }

        .post-actions {
          display: flex;
          padding: 16px 20px;
          border-top: 1px solid rgba(255, 255, 255, 0.05);
          border-bottom: 1px solid rgba(255, 255, 255, 0.05);
        }

        .post-action-btn {
          flex: 1;
          background: none;
          border: none;
          color: #888;
          cursor: pointer;
          padding: 10px;
          border-radius: 8px;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          transition: all 0.3s ease;
          font-size: 14px;
        }

        .post-action-btn:hover {
          color: white;
          background: rgba(255, 51, 51, 0.1);
        }

        /* COMMENTS SECTION */
        .comments-section {
          padding: 20px;
        }

        .comments-list {
          margin-bottom: 20px;
        }

        .no-comments {
          text-align: center;
          padding: 20px;
          color: #666;
          font-style: italic;
          font-size: 14px;
        }

        .view-all-comments {
          width: 100%;
          background: none;
          border: none;
          color: #ff6666;
          padding: 10px;
          cursor: pointer;
          font-size: 14px;
          text-align: center;
          transition: all 0.3s ease;
        }

        .view-all-comments:hover {
          color: #ff3333;
        }

        .comment-item {
          display: flex;
          gap: 12px;
          margin-bottom: 16px;
        }

        .comment-item.reply {
          margin-left: 40px;
        }

        .comment-avatar {
          width: 36px;
          height: 36px;
          border-radius: 50%;
          overflow: hidden;
          flex-shrink: 0;
          border: 1px solid rgba(255, 51, 51, 0.3);
        }

        .comment-avatar img {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }

        .comment-content {
          flex: 1;
        }

        .comment-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 4px;
        }

        .comment-author {
          font-weight: 600;
          color: white;
          font-size: 14px;
        }

        .comment-time {
          font-size: 11px;
          color: #666;
        }

        .comment-text {
          color: #ccc;
          font-size: 14px;
          line-height: 1.4;
          margin-bottom: 8px;
        }

        .comment-actions {
          display: flex;
          gap: 12px;
        }

        .comment-action-btn {
          background: none;
          border: none;
          color: #888;
          cursor: pointer;
          font-size: 12px;
          display: flex;
          align-items: center;
          gap: 4px;
          transition: all 0.3s ease;
          padding: 4px 8px;
          border-radius: 6px;
        }

        .comment-action-btn:hover {
          color: #ff3333;
          background: rgba(255, 51, 51, 0.1);
        }

        .reply-input-container {
          display: flex;
          gap: 10px;
          margin-top: 12px;
        }

        .reply-input-container input {
          flex: 1;
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(255, 51, 51, 0.3);
          border-radius: 20px;
          padding: 10px 15px;
          color: white;
          font-size: 13px;
          outline: none;
          transition: all 0.3s ease;
        }

        .reply-input-container input:focus {
          border-color: #ff3333;
        }

        .send-reply-btn {
          background: linear-gradient(45deg, #ff3333, #ff6666);
          border: none;
          color: white;
          padding: 10px 20px;
          border-radius: 20px;
          cursor: pointer;
          font-size: 13px;
          font-weight: 600;
          transition: all 0.3s ease;
        }

        .send-reply-btn:hover {
          transform: translateY(-2px);
          box-shadow: 0 4px 12px rgba(255, 51, 51, 0.3);
        }

        .replies-container {
          margin-top: 12px;
          border-left: 2px solid rgba(255, 51, 51, 0.2);
          padding-left: 16px;
        }

        /* ADD COMMENT FORM */
        .add-comment-form {
          margin-top: 20px;
        }

        .comment-input-wrapper {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .comment-avatar-small {
          width: 36px;
          height: 36px;
          border-radius: 50%;
          overflow: hidden;
          flex-shrink: 0;
          border: 1px solid rgba(255, 51, 51, 0.3);
        }

        .comment-avatar-small img {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }

        .comment-input-group {
          flex: 1;
          display: flex;
          gap: 10px;
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(255, 51, 51, 0.3);
          border-radius: 24px;
          padding: 6px 6px 6px 16px;
          transition: all 0.3s ease;
        }

        .comment-input-group:focus-within {
          border-color: #ff3333;
        }

        .comment-input {
          flex: 1;
          background: none;
          border: none;
          color: white;
          font-size: 14px;
          outline: none;
        }

        .comment-submit-btn {
          background: linear-gradient(45deg, #ff3333, #ff6666);
          border: none;
          color: white;
          width: 32px;
          height: 32px;
          border-radius: 50%;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.3s ease;
          flex-shrink: 0;
        }

        .comment-submit-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .comment-submit-btn:not(:disabled):hover {
          transform: scale(1.1);
          box-shadow: 0 4px 12px rgba(255, 51, 51, 0.3);
        }

        /* RIGHT SIDEBAR */
        .profile-card {
          background: rgba(26, 0, 0, 0.8);
          border: 1px solid rgba(255, 0, 0, 0.2);
          border-radius: 16px;
          padding: 24px;
          backdrop-filter: blur(10px);
        }

        .profile-header {
          text-align: center;
          margin-bottom: 24px;
        }

        .profile-avatar {
          width: 80px;
          height: 80px;
          border-radius: 50%;
          overflow: hidden;
          border: 3px solid #ff3333;
          margin: 0 auto 16px;
        }

        .profile-avatar img {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }

        .profile-info {
          text-align: center;
        }

        .profile-name {
          font-size: 18px;
          font-weight: 700;
          color: white;
          margin-bottom: 4px;
        }

        .profile-email {
          color: #888;
          font-size: 14px;
        }

        .profile-stats {
          display: flex;
          justify-content: space-around;
          border-top: 1px solid rgba(255, 255, 255, 0.05);
          padding-top: 20px;
        }

        .profile-stat {
          text-align: center;
        }

        .stat-value {
          font-size: 20px;
          font-weight: 700;
          color: #ff3333;
          margin-bottom: 4px;
        }

        .stat-label {
          font-size: 12px;
          color: #888;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        /* UTILITIES */
        .fa-spin {
          animation: fa-spin 1s linear infinite;
        }

        @keyframes fa-spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}</style>
    </>
  );
}
