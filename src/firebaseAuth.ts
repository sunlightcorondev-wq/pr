import { initializeApp } from "firebase/app";
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, User } from "firebase/auth";
import firebaseConfig from "../firebase-applet-config.json";

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

const provider = new GoogleAuthProvider();
// Request exact scopes requested: drive.file and spreadsheets
provider.addScope("https://www.googleapis.com/auth/spreadsheets");
provider.addScope("https://www.googleapis.com/auth/drive.file");

let isSigningIn = false;
let cachedAccessToken: string | null = null;

// Initialize auth state listener. Call this on app load.
export const initAuth = (
  onAuthSuccess?: (user: User, token: string) => void,
  onAuthFailure?: () => void
) => {
  return onAuthStateChanged(auth, async (user: User | null) => {
    console.log("Auth state changed, user:", !!user, "cachedAccessToken:", !!cachedAccessToken, "isSigningIn:", isSigningIn);
    if (user) {
      if (cachedAccessToken) {
        console.log("Auth success, calling onAuthSuccess");
        if (onAuthSuccess) onAuthSuccess(user, cachedAccessToken);
      } else if (!isSigningIn) {
        // Try to trigger a sign-in or let caller know they need to authorize
        console.log("Auth failure, calling onAuthFailure");
        cachedAccessToken = null;
        if (onAuthFailure) onAuthFailure();
      }
    } else {
      console.log("Auth failure (no user), calling onAuthFailure");
      cachedAccessToken = null;
      if (onAuthFailure) onAuthFailure();
    }
  });
};

// Handle redirect result on app load (not needed for popup)
export const handleRedirectResult = async (): Promise<{ user: User; accessToken: string } | null> => {
  return null;
};

// Must be called from a button click or user interaction
export const googleSignIn = async (): Promise<{ user: User; accessToken: string }> => {
  try {
    isSigningIn = true;
    console.log("Attempting sign in with popup...");
    const result = await signInWithPopup(auth, provider);
    console.log("Popup sign in successful.");
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (credential?.accessToken) {
      cachedAccessToken = credential.accessToken;
      return { user: result.user, accessToken: cachedAccessToken };
    }
    throw new Error("No access token found");
  } catch (error: any) {
    console.error("Sign in error:", error);
    throw error;
  } finally {
    isSigningIn = false;
  }
};

export const getAccessToken = async (): Promise<string | null> => {
  return cachedAccessToken;
};

export const logout = async () => {
  await auth.signOut();
  cachedAccessToken = null;
};
