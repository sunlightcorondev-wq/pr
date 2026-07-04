import React from "react";
import { Shield, Sparkles } from "lucide-react";

interface AuthOverlayProps {
  onLogin: () => void;
  isLoggingIn: boolean;
}

export function AuthOverlay({ onLogin, isLoggingIn }: AuthOverlayProps) {
  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-center items-center px-4 py-12">
      <div className="w-full max-w-md bg-white border border-slate-200 shadow-xl rounded-2xl p-8 text-center space-y-6">
        <div className="mx-auto w-14 h-14 bg-sky-50 text-sky-600 rounded-2xl flex items-center justify-center">
          <Sparkles className="w-7 h-7" />
        </div>

        <div className="space-y-2">
          <h1 className="text-2xl font-bold text-slate-800 tracking-tight">
            Requisition OCR Tracker
          </h1>
          <p className="text-sm text-slate-500 leading-relaxed">
            Extract data automatically from Requisition Forms & Packing Lists and sync directly into your Google Sheet with Gemini.
          </p>
        </div>

        <div className="border-t border-slate-100 my-4"></div>

        <div>
          <button
            onClick={onLogin}
            disabled={isLoggingIn}
            className="w-full flex items-center justify-center gap-3 bg-white border border-slate-300 hover:border-slate-400 text-slate-700 font-medium py-3 px-6 rounded-xl hover:bg-slate-50 active:bg-slate-100 shadow-sm transition-all focus:outline-none focus:ring-2 focus:ring-slate-500/20 disabled:opacity-60 cursor-pointer"
          >
            <svg version="1.1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" className="w-5 h-5 flex-shrink-0">
              <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"></path>
              <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"></path>
              <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"></path>
              <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"></path>
              <path fill="none" d="M0 0h48v48H0z"></path>
            </svg>
            <span>{isLoggingIn ? "Signing in..." : "Sign in with Google"}</span>
          </button>
        </div>

        <div className="flex items-center justify-center gap-1.5 text-xs text-slate-400">
          <Shield className="w-3.5 h-3.5" />
          <span>Secure OAuth connection directly with Google APIs</span>
        </div>
      </div>
    </div>
  );
}
