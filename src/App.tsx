import React, { useState, useEffect } from "react";
import { User } from "firebase/auth";
import { Sparkles, LogOut, FileText, FileSpreadsheet, Layers, ShieldCheck, HelpCircle, Link } from "lucide-react";
import { initAuth, googleSignIn, logout, handleRedirectResult } from "./firebaseAuth";
import { AuthOverlay } from "./components/AuthOverlay";
import { SpreadsheetSelector } from "./components/SpreadsheetSelector";
import { RequisitionScanner } from "./components/RequisitionScanner";
import { PackingListScanner } from "./components/PackingListScanner";
import { StatusViewer } from "./components/StatusViewer";

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [spreadsheetId, setSpreadsheetId] = useState<string>(
    localStorage.getItem("requisition_spreadsheet_id") || ""
  );
  const [activeTab, setActiveTab] = useState<"requisition" | "receiving" | "ledger">("requisition");
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  useEffect(() => {
    let unsubscribe: () => void;

    const setupAuth = async () => {
      const result = await handleRedirectResult();
      if (result) {
        setToken(result.accessToken);
        setUser(result.user);
        setNeedsAuth(false);
      }

      // Initialize Firebase authentication listener
      unsubscribe = initAuth(
        (currentUser, accessToken) => {
          setUser(currentUser);
          // Only update token if we don't have a valid Google access token
          setToken(prev => prev || accessToken);
          setNeedsAuth(false);
        },
        () => {
          setUser(null);
          setToken(null);
          setNeedsAuth(true);
        }
      );
    };

    setupAuth();

    return () => unsubscribe && unsubscribe();
  }, []);

  const handleLogin = async () => {
    setIsLoggingIn(true);
    try {
      await googleSignIn();
    } catch (err) {
      console.error("Sign-in failed:", err);
      setIsLoggingIn(false);
    }
  };

  const handleLogout = async () => {
    await logout();
    setUser(null);
    setToken(null);
    setNeedsAuth(true);
  };

  const handleSheetUpdateTrigger = () => {
    setRefreshTrigger((prev) => prev + 1);
  };

  // 1. If not authenticated, prompt sign-in
  if (needsAuth || !user || !token) {
    return <AuthOverlay onLogin={handleLogin} isLoggingIn={isLoggingIn} />;
  }

  // 2. If spreadsheet is not configured yet, force selector
  const hasSpreadsheet = spreadsheetId && spreadsheetId.trim() !== "";

  return (
    <div id="app-root" className="min-h-screen bg-slate-50 flex flex-col font-sans">
      {/* Upper Navigation Bar */}
      <header className="bg-white border-b border-slate-150 sticky top-0 z-50 shadow-xs">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="p-1.5 bg-gradient-to-tr from-blue-600 to-slate-800 text-white rounded-lg shadow-sm">
              <Sparkles className="w-4 h-4 animate-pulse" />
            </div>
            <div>
              <span className="font-bold text-slate-800 tracking-tight text-xs block font-sans">
                Requisition Sync
              </span>
              <span className="text-[8px] text-slate-400 font-bold uppercase tracking-wider block font-mono">
                Gemini OCR Engine
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Spreadsheet deep link */}
            {hasSpreadsheet && (
              <a
                href={`https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`}
                target="_blank"
                rel="noreferrer"
                className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 border border-slate-250 rounded-lg text-[10px] font-bold text-slate-600 hover:text-slate-800 hover:bg-slate-50 transition-all"
              >
                <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-600" />
                <span>Open Google Sheet</span>
                <Link className="w-2.5 h-2.5 text-slate-400" />
              </a>
            )}

            {/* Profile display / Logout */}
            <div className="flex items-center gap-2 border-l border-slate-200 pl-3">
              {user.photoURL ? (
                <img
                  src={user.photoURL}
                  alt={user.displayName || "User Avatar"}
                  className="w-7 h-7 rounded-full border border-slate-200"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="w-7 h-7 bg-sky-100 text-sky-850 rounded-full flex items-center justify-center font-bold text-[10px] uppercase">
                  {user.displayName?.charAt(0) || user.email?.charAt(0) || "U"}
                </div>
              )}
              <div className="hidden md:block text-left">
                <p className="text-[10px] font-semibold text-slate-700 max-w-[120px] truncate leading-tight">
                  {user.displayName || "Logged In User"}
                </p>
                <p className="text-[8px] text-slate-400 leading-none truncate max-w-[120px] mt-0.5">
                  {user.email}
                </p>
              </div>
              <button
                onClick={handleLogout}
                className="p-1 text-slate-400 hover:text-rose-500 rounded-lg hover:bg-slate-50 transition-all cursor-pointer"
                title="Sign out of system"
              >
                <LogOut className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-3">
        {!hasSpreadsheet ? (
          <div className="py-4">
            <SpreadsheetSelector
              accessToken={token}
              spreadsheetId={spreadsheetId}
              setSpreadsheetId={setSpreadsheetId}
              onConnected={handleSheetUpdateTrigger}
            />
          </div>
        ) : (
          <div className="space-y-4">
            {/* View Switching Tab Header */}
            <div className="flex flex-col md:flex-row items-center justify-between gap-3 border-b border-slate-100 pb-2">
              <div className="bg-slate-100/85 p-0.5 rounded-xl flex w-full md:w-auto items-center gap-0.5 border border-slate-200/50">
                <button
                  onClick={() => setActiveTab("requisition")}
                  className={`flex-1 md:flex-none py-1.5 px-3 rounded-lg font-bold text-[11px] transition-all cursor-pointer flex items-center justify-center gap-1.5 ${
                    activeTab === "requisition"
                      ? "bg-white text-blue-600 shadow-sm border border-slate-200/10"
                      : "text-slate-500 hover:text-slate-800 hover:bg-white/40"
                  }`}
                >
                  <FileText className="w-3.5 h-3.5" />
                  <span>1. Requisition Upload</span>
                </button>
                <button
                  onClick={() => setActiveTab("receiving")}
                  className={`flex-1 md:flex-none py-1.5 px-3 rounded-lg font-bold text-[11px] transition-all cursor-pointer flex items-center justify-center gap-1.5 ${
                    activeTab === "receiving"
                      ? "bg-white text-blue-600 shadow-sm border border-slate-200/10"
                      : "text-slate-500 hover:text-slate-800 hover:bg-white/40"
                  }`}
                >
                  <Layers className="w-3.5 h-3.5" />
                  <span>2. Receive & Match</span>
                </button>
                <button
                  onClick={() => setActiveTab("ledger")}
                  className={`flex-1 md:flex-none py-1.5 px-3 rounded-lg font-bold text-[11px] transition-all cursor-pointer flex items-center justify-center gap-1.5 ${
                    activeTab === "ledger"
                      ? "bg-white text-blue-600 shadow-sm border border-slate-200/10"
                      : "text-slate-500 hover:text-slate-800 hover:bg-white/40"
                  }`}
                >
                  <FileSpreadsheet className="w-3.5 h-3.5" />
                  <span>3. Sheet Ledger</span>
                </button>
              </div>

              <button
                onClick={() => {
                  setSpreadsheetId("");
                }}
                className="text-[10px] text-blue-600 hover:text-blue-700 font-bold hover:underline cursor-pointer flex items-center gap-1 px-2.5 py-1 bg-blue-50/50 rounded-lg border border-blue-100/40 transition-colors"
              >
                Change Spreadsheet Target
              </button>
            </div>
            
            {/* Tab Body views */}
            <div>
              {activeTab === "requisition" && (
                <div className="animate-fadeIn">
                  <div className="mb-3">
                    <h2 className="text-sm font-bold text-slate-800">Scan Requisition Form</h2>
                    <p className="text-[11px] text-slate-450 mt-0.5">
                      Extract Serial codes, categories, particular items, quantities, and departments. Review extracted fields before confirming uploads.
                    </p>
                  </div>
                  <RequisitionScanner
                    accessToken={token}
                    spreadsheetId={spreadsheetId}
                    onSuccess={handleSheetUpdateTrigger}
                  />
                </div>
              )}

              {activeTab === "receiving" && (
                <div className="animate-fadeIn">
                  <div className="mb-3">
                    <h2 className="text-sm font-bold text-slate-800">Scan Packing List & Match</h2>
                    <p className="text-[11px] text-slate-450 mt-0.5">
                      Upload the Packing List. Gemini lists received items. Our matching engine automatically matches items against pending requisitions.
                    </p>
                  </div>
                  <PackingListScanner
                    accessToken={token}
                    spreadsheetId={spreadsheetId}
                    onSuccess={handleSheetUpdateTrigger}
                  />
                </div>
              )}

              {activeTab === "ledger" && (
                <div className="animate-fadeIn">
                  <StatusViewer
                    accessToken={token}
                    spreadsheetId={spreadsheetId}
                    refreshTrigger={refreshTrigger}
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="bg-white border-t border-slate-100 py-6 mt-12">
        <div className="max-w-7xl mx-auto px-4 text-center sm:flex sm:justify-between sm:items-center">
          <p className="text-xs text-slate-400">
            Powered by Gemini-3.5-Flash OCR. Completely offline-secure and Workspace direct integrations.
          </p>
          <p className="text-[10px] text-slate-400 flex items-center justify-center gap-1 mt-2 sm:mt-0">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" />
            <span>Authorized sheet & drive storage secure scope active</span>
          </p>
        </div>
      </footer>
    </div>
  );
}
