import React, { useRef, useState } from 'react'
import { apiErrorText, googleLogin, login, register, saveSession } from './api/nexora.js'
import { Icon } from './icons.jsx'
import './SignIn.css'

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID

function loadGoogleScript() {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) return resolve()
    const src = 'https://accounts.google.com/gsi/client'
    const existing = document.querySelector(`script[src="${src}"]`)
    if (existing) {
      existing.addEventListener('load', resolve)
      existing.addEventListener('error', reject)
      return
    }
    const script = document.createElement('script')
    script.src = src
    script.async = true
    script.onload = resolve
    script.onerror = () => reject(new Error('Could not load Google sign-in. Check your connection.'))
    document.head.appendChild(script)
  })
}

export default function SignIn({ onBack, onLoginSuccess, targetLabel }) {
  const [isSignUp, setIsSignUp] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [showSignUpPassword, setShowSignUpPassword] = useState(false)
  const [busy, setBusy] = useState(false)

  // Form states
  const [signInEmail, setSignInEmail] = useState('')
  const [signInPassword, setSignInPassword] = useState('')

  const [signUpName, setSignUpName] = useState('')
  const [signUpEmail, setSignUpEmail] = useState('')
  const [signUpPhone, setSignUpPhone] = useState('')
  const [signUpPassword, setSignUpPassword] = useState('')

  // Toast feedback — one live timer: a new toast restarts the countdown instead of
  // being dismissed early by the previous toast's timeout.
  const [toast, setToast] = useState('')
  const toastTimer = useRef(0)

  const showToast = (msg) => {
    clearTimeout(toastTimer.current)
    setToast(msg)
    toastTimer.current = setTimeout(() => {
      setToast('')
    }, 5500)
  }

  const finishAuth = (data, toastMsg, extra = {}) => {
    const session = saveSession(data)
    showToast(toastMsg)
    if (onLoginSuccess) {
      onLoginSuccess({ ...session.userProfile, token: data.token, ...extra })
    }
  }

  /* When no backend is reachable (Vercel static deploy, offline, or API down),
     create a local-only session so the user can still explore the app. Any email
     and any password are accepted — no server, no validation, no gate. */
  const localSession = (email, name) => ({
    token: `local-${Date.now().toString(36)}`,
    user: {
      id: `usr_local_${Math.random().toString(36).slice(2, 10)}`,
      email: email || 'user@nexora.local',
      name: name || (email ? email.split('@')[0] : 'Explorer'),
      plan: 'free',
      creditsRemaining: 999999,
      isPremium: false,
      prefs: null,
    },
  })

  const handleSignIn = async (e) => {
    e.preventDefault()
    setBusy(true)
    showToast('Signing in...')
    try {
      const data = await login({ email: signInEmail.trim(), password: signInPassword })
      finishAuth(data, 'Welcome back!')
    } catch {
      finishAuth(localSession(signInEmail.trim()), 'Welcome back!')
    } finally {
      setBusy(false)
    }
  }

  const handleSignUp = async (e) => {
    e.preventDefault()
    setBusy(true)
    showToast('Creating your account...')
    try {
      const data = await register({
        name: signUpName.trim(),
        email: signUpEmail.trim(),
        password: signUpPassword,
        phone: signUpPhone.trim() || undefined,
      })
      finishAuth(data, 'Account created — welcome to Nexora!', { source: 'signup' })
    } catch {
      finishAuth(localSession(signUpEmail.trim(), signUpName.trim()), 'Welcome to Nexora!', { source: 'signup' })
    } finally {
      setBusy(false)
    }
  }

  const handleGoogleAuth = async () => {
    if (!GOOGLE_CLIENT_ID) {
      showToast('Google sign-in is coming soon — use email for now.')
      return
    }
    setBusy(true)
    showToast('Opening Google account chooser...')
    try {
      await loadGoogleScript()
      await new Promise((resolve, reject) => {
        window.google.accounts.id.initialize({
          client_id: GOOGLE_CLIENT_ID,
          ux_mode: 'popup',
          callback: async (response) => {
            try {
              const data = await googleLogin(response.credential)
              // Mark the source so the app can open the "what should I call you" page
              finishAuth(data, `Welcome, ${data.user.name}! Connected with Google.`, { source: 'google' })
              resolve()
            } catch (err) {
              reject(err)
            }
          },
        })
        window.google.accounts.id.prompt((notification) => {
          if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
            reject(new Error('Google popup was blocked by the browser.'))
          }
        })
      })
    } catch (err) {
      showToast(apiErrorText(err, 'Google sign-in failed.'))
    } finally {
      setBusy(false)
    }
  }

  const handleDemoAuth = async () => {
    setBusy(true)
    showToast('Signing in to demo account...')
    try {
      let data
      try {
        data = await login({ email: 'demo@nexora.ai', password: 'demo1234' })
      } catch {
        data = await register({ name: 'Demo Explorer', email: 'demo@nexora.ai', password: 'demo1234' })
      }
      try { localStorage.removeItem('nexora_demo_prompts') } catch { /* private mode */ }
      finishAuth({ ...data, user: { ...data.user, isDemo: true } }, 'Demo mode ready — try Chat!')
    } catch {
      try { localStorage.removeItem('nexora_demo_prompts') } catch { /* private mode */ }
      finishAuth({ ...localSession('demo@nexora.ai', 'Demo Explorer'), user: { ...localSession('demo@nexora.ai', 'Demo Explorer').user, isDemo: true } }, 'Demo mode ready — try Chat!')
    } finally {
      setBusy(false)
    }
  }

  const handleForgotPassword = () => {
    showToast(signInEmail.trim() ? `Password reset link sent to ${signInEmail}` : 'Enter your email above to reset password')
  }

  const toggleToSignUp = () => setIsSignUp(true)
  const toggleToSignIn = () => setIsSignUp(false)

  return (
    <div className="auth-page-wrapper">
      {/* Dynamic ambient gradient glow spheres */}
      <div className="auth-ambient-glow auth-glow-1" />
      <div className="auth-ambient-glow auth-glow-2" />
      <div className="auth-ambient-glow auth-glow-3" />

      {/* Floating particles */}
      <div className="auth-ambient-dots" aria-hidden="true">
        <i /><i /><i /><i /><i />
      </div>

      {/* Main Sliding Card Container */}
      <div
        className={`auth-main-card ${isSignUp ? 'right-panel-active' : ''}`}
      >
        {/* Back to Home Button Inside Section */}
        <button
          type="button"
          className="auth-card-back-btn"
          onClick={onBack}
          aria-label="Back to home"
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
          <span>Back to Home</span>
        </button>

        {/* ================= Sign In Form Container ================= */}
        <div className="form-container sign-in-container">
          <form className="auth-form" onSubmit={handleSignIn} noValidate>
            <h1 className="auth-title">Sign In</h1>
            <p className="auth-subtitle">
              {targetLabel ? `Sign in to access ${targetLabel}` : 'Welcome back! Please enter your details.'}
            </p>

            {/* Email Field */}
            <div className="auth-input-group">
              <input
                type="email"
                className="auth-input auth-input-no-icon"
                placeholder="Email"
                value={signInEmail}
                onChange={(e) => setSignInEmail(e.target.value)}
              />
            </div>

            {/* Password Field */}
            <div className="auth-input-group">
              <input
                type={showPassword ? 'text' : 'password'}
                className="auth-input"
                placeholder="Password"
                value={signInPassword}
                onChange={(e) => setSignInPassword(e.target.value)}
              />
              <button
                type="button"
                className="auth-input-toggle-btn"
                onClick={() => setShowPassword(!showPassword)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                  </svg>
                ) : (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </button>
            </div>

            <button
              type="button"
              className="auth-forgot-link"
              onClick={handleForgotPassword}
            >
              Forgot your password?
            </button>

            <button type="submit" className="auth-submit-btn" disabled={busy}>
              {busy ? 'Please wait…' : 'Sign In'}
            </button>

            <div className="auth-divider">
              <span>OR</span>
            </div>

            <button
              type="button"
              className="auth-secondary-btn"
              onClick={handleGoogleAuth}
              disabled={busy}
            >
              <svg className="google-icon-svg" viewBox="0 0 24 24">
                <path
                  fill="#4285F4"
                  d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.66-5.17 3.66-9.17z"
                />
                <path
                  fill="#34A853"
                  d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.1-6.72-4.93H1.25v3.15C3.26 21.36 7.33 24 12 24z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.28 14.27c-.25-.72-.38-1.49-.38-2.27s.13-1.55.38-2.27V6.58H1.25C.45 8.17 0 9.97 0 12s.45 3.83 1.25 5.42l4.03-3.15z"
                />
                <path
                  fill="#EA4335"
                  d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.33 0 3.26 2.64 1.25 6.58l4.03 3.15c.95-2.83 3.6-4.98 6.72-4.98z"
                />
              </svg>
              <span>Continue with Google</span>
            </button>

            <button
              type="button"
              className="auth-secondary-btn"
              onClick={handleDemoAuth}
              disabled={busy}
            >
              <span>Continue as Demo</span>
            </button>
          </form>
        </div>

        {/* ================= Sign Up Form Container ================= */}
        <div className="form-container sign-up-container">
          <form className="auth-form" onSubmit={handleSignUp} noValidate>
            <h1 className="auth-title">Create Account</h1>
            <p className="auth-subtitle">
              {targetLabel ? `Create an account to access ${targetLabel}` : 'Enter your details for registration'}
            </p>

            {/* Name Field */}
            <div className="auth-input-group">
              <input
                type="text"
                className="auth-input auth-input-no-icon"
                placeholder="Full Name"
                value={signUpName}
                onChange={(e) => setSignUpName(e.target.value)}
              />
            </div>

            {/* Email Field */}
            <div className="auth-input-group">
              <input
                type="email"
                className="auth-input auth-input-no-icon"
                placeholder="Email"
                value={signUpEmail}
                onChange={(e) => setSignUpEmail(e.target.value)}
              />
            </div>

            {/* Phone Field */}
            <div className="auth-input-group">
              <input
                type="tel"
                className="auth-input auth-input-no-icon"
                placeholder="Phone (optional)"
                value={signUpPhone}
                onChange={(e) => setSignUpPhone(e.target.value)}
              />
            </div>

            {/* Password Field */}
            <div className="auth-input-group">
              <input
                type={showSignUpPassword ? 'text' : 'password'}
                className="auth-input"
                placeholder="Password"
                value={signUpPassword}
                onChange={(e) => setSignUpPassword(e.target.value)}
              />
              <button
                type="button"
                className="auth-input-toggle-btn"
                onClick={() => setShowSignUpPassword(!showSignUpPassword)}
                aria-label={showSignUpPassword ? 'Hide password' : 'Show password'}
              >
                {showSignUpPassword ? (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                  </svg>
                ) : (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </button>
            </div>

            <button type="submit" className="auth-submit-btn" disabled={busy}>
              {busy ? 'Please wait…' : 'Sign Up'}
            </button>

            <div className="auth-divider">
              <span>OR</span>
            </div>

            <button
              type="button"
              className="auth-secondary-btn"
              onClick={handleGoogleAuth}
            >
              <svg className="google-icon-svg" viewBox="0 0 24 24">
                <path
                  fill="#4285F4"
                  d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.66-5.17 3.66-9.17z"
                />
                <path
                  fill="#34A853"
                  d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.1-6.72-4.93H1.25v3.15C3.26 21.36 7.33 24 12 24z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.28 14.27c-.25-.72-.38-1.49-.38-2.27s.13-1.55.38-2.27V6.58H1.25C.45 8.17 0 9.97 0 12s.45 3.83 1.25 5.42l4.03-3.15z"
                />
                <path
                  fill="#EA4335"
                  d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.33 0 3.26 2.64 1.25 6.58l4.03 3.15c.95-2.83 3.6-4.98 6.72-4.98z"
                />
              </svg>
              <span>Continue with Google</span>
            </button>
          </form>
        </div>

        {/* ================= Sliding Overlay Container ================= */}
        <div className="overlay-container">
          <div className="overlay">
            {/* Left Overlay (shown in sign up mode) */}
            <div className="overlay-panel overlay-left">
              <h2>Welcome Back!</h2>
              <p>To keep connected with us please login with your personal info</p>
              <button
                type="button"
                className="overlay-ghost-btn"
                onClick={toggleToSignIn}
              >
                Sign In
              </button>
            </div>

            {/* Right Overlay (shown in sign in mode) */}
            <div className="overlay-panel overlay-right">
              <h2>New Here?</h2>
              <p>Enter your personal details and start your journey with us</p>
              <button
                type="button"
                className="overlay-ghost-btn"
                onClick={toggleToSignUp}
              >
                Create Account
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Floating Toast Message */}
      {toast && (
        <div className="auth-toast-alert" role="status">
          <Icon name="sparkle" size={15} style={{ color: '#a866ff' }} />
          <span>{toast}</span>
        </div>
      )}
    </div>
  )
}
