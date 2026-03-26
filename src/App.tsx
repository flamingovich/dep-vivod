import React, { useState, useEffect, useCallback, useRef } from "react";
import { 
  PlusCircle, 
  MinusCircle, 
  ThumbsUp, 
  Settings, 
  Save, 
  RefreshCw, 
  ExternalLink,
  AlertCircle,
  ArrowDownCircle,
  ArrowUpCircle,
  Youtube
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { cn } from "./lib/utils";
import { db } from "./firebase";
import { 
  doc, 
  onSnapshot, 
  setDoc, 
  Timestamp,
} from "firebase/firestore";

interface AppState {
  deposit: number;
  withdrawal: number;
  goalLikes: number;
  currentLikes: number;
  videoId: string;
  channelUrl: string;
  isActive: boolean;
}

const DEFAULT_STATE: AppState = {
  deposit: 0,
  withdrawal: 0,
  goalLikes: 100,
  currentLikes: 0,
  videoId: "",
  channelUrl: "",
  isActive: false,
};

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export default function App() {
  const [state, setState] = useState<AppState>(DEFAULT_STATE);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);

  // Config check
  useEffect(() => {
    fetch("/api/config-check")
      .then(res => res.json())
      .then(data => setHasApiKey(data.hasApiKey))
      .catch(() => setHasApiKey(false));
  }, []);

  // Firestore listener
  useEffect(() => {
    const docRef = doc(db, "settings", "widget");
    const unsubscribe = onSnapshot(docRef, (docSnap) => {
      if (docSnap.exists()) {
        setState(docSnap.data() as AppState);
      }
      setLoading(false);
    }, (err) => {
      console.error("Firestore error:", err);
      setError("Ошибка подключения к базе данных.");
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  // Admin mode check
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("admin") === "true") {
      setIsAdmin(true);
    }
  }, []);

  const updateState = async (updates: Partial<AppState>) => {
    try {
      const docRef = doc(db, "settings", "widget");
      // CRITICAL: We only send the updates object to Firestore. 
      // setDoc with { merge: true } will only update the provided fields.
      // This prevents stale local 'state' from overwriting other fields.
      await setDoc(docRef, {
        ...updates,
        updatedAt: Timestamp.now()
      }, { merge: true });
      setError(null);
    } catch (err: any) {
      console.error("Update error:", err);
      setError("Ошибка сохранения данных.");
    }
  };

  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const isFetching = useRef(false);

  const fetchLikesFromServer = useCallback(async () => {
    const currentState = stateRef.current;
    if (!currentState.isActive || isFetching.current) return;
    
    isFetching.current = true;
    let currentVideoId = currentState.videoId;

    try {
      // If channel URL is provided AND we don't have a videoId yet, try to detect
      // Or if we have a channel URL, we keep checking for live stream to update ID
      if (currentState.channelUrl) {
        try {
          const detectRes = await fetch(`/api/detect-live?channelUrl=${encodeURIComponent(currentState.channelUrl)}`);
          const detectData = await detectRes.json();
          if (detectData.isLive && detectData.videoId) {
            currentVideoId = detectData.videoId;
            if (currentVideoId !== currentState.videoId) {
              console.log(`New live stream detected: ${currentVideoId}`);
              await updateState({ videoId: currentVideoId });
            }
          } else if (!detectData.isLive && currentState.videoId) {
            // If we had a videoId but now it's not live, we might want to keep it 
            // for a few retries or just log it. 
            // For now, let's keep it to avoid "flickering" if detection fails once.
            console.warn("Stream detection says not live, but we have a videoId. Keeping it for now.");
          }
        } catch (err) {
          console.error("Live detection error:", err);
        }
      }

      if (currentVideoId || currentState.channelUrl) {
        console.log(`Fetching likes for videoId: ${currentVideoId}, channelUrl: ${currentState.channelUrl}`);
        // Try official API first, fallback to scraper
        const response = await fetch(`/api/fetch-likes-api?videoId=${currentVideoId || ""}&channelUrl=${encodeURIComponent(currentState.channelUrl || "")}`);
        let data = await response.json();
        
        if (data.error) {
          console.warn("API failed, falling back to scraper:", data.error);
          const scraperRes = await fetch(`/api/fetch-likes?videoId=${currentVideoId || ""}&channelUrl=${encodeURIComponent(currentState.channelUrl || "")}`);
          data = await scraperRes.json();
        }

        if (data.likes !== undefined && data.likes !== currentState.currentLikes) {
          await updateState({ currentLikes: data.likes });
        }
      }
    } catch (err) {
      console.error("Fetch likes error:", err);
    } finally {
      isFetching.current = false;
    }
  }, []); // No dependencies needed as we use refs

  // Auto-update effect
  useEffect(() => {
    if (!state.isActive) return;

    // Initial fetch
    fetchLikesFromServer();

    const interval = setInterval(fetchLikesFromServer, 20000);
    return () => clearInterval(interval);
  }, [state.isActive, state.channelUrl, state.videoId]); // Depend on these to re-trigger on change

  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <RefreshCw className="w-8 h-8 text-blue-500 animate-spin" />
      </div>
    );
  }

  if (isAdmin) {
    return (
      <ControlPanel 
        state={state} 
        updateState={updateState} 
        onRefresh={fetchLikesFromServer}
        error={error}
        hasApiKey={hasApiKey}
      />
    );
  }

  return <Widget state={state} />;
}

function formatValue(num: number): string {
  if (num >= 1000000) {
    return `${Math.floor(num / 1000000)}кк`;
  }
  if (num >= 1000) {
    return `${Math.floor(num / 1000)}к`;
  }
  return num.toString();
}

function Widget({ state }: { state: AppState }) {
  const progress = Math.min((state.currentLikes / state.goalLikes) * 100, 100);

  return (
    <div className="min-h-screen flex items-center justify-center bg-transparent font-sans">
      <div className="bg-zinc-950/95 border border-white/10 p-6 rounded-lg shadow-2xl text-white min-w-[420px] relative overflow-hidden">
        {/* Subtle Gradient Background Overlay */}
        <div className="absolute inset-0 bg-gradient-to-br from-zinc-900 via-zinc-950 to-zinc-900 pointer-events-none" />
        
        {/* Top Row: Numbers only with icons */}
        <div className="relative z-10 flex justify-between items-center mb-6 px-2">
          <div className="flex items-center gap-4">
            <ArrowDownCircle className="text-green-500 w-8 h-8" />
            <span className="text-5xl font-black tabular-nums tracking-tighter">
              {formatValue(state.deposit)}
            </span>
          </div>

          <div className="w-px h-12 bg-white/10 mx-4" />

          <div className="flex items-center gap-4">
            <span className="text-5xl font-black tabular-nums tracking-tighter">
              {formatValue(state.withdrawal)}
            </span>
            <ArrowUpCircle className="text-red-500 w-8 h-8" />
          </div>
        </div>

        {/* Bottom Row: Goal */}
        <div className="relative z-10 space-y-3 px-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-lg font-black text-zinc-500 uppercase tracking-[0.2em]">ЦЕЛЬ:</span>
              <div className="flex items-center gap-2">
                <ThumbsUp className="text-white w-8 h-8 fill-white" />
                <span className="text-5xl font-black tabular-nums">
                  {state.currentLikes} / {state.goalLikes}
                </span>
              </div>
            </div>
          </div>

          {/* Progress Bar - Flat style */}
          <div className="h-4 bg-white/10 rounded-none overflow-hidden">
            <div 
              className="h-full bg-white transition-all duration-1000 ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function ControlPanel({ 
  state, 
  updateState, 
  onRefresh,
  error,
  hasApiKey
}: { 
  state: AppState; 
  updateState: (updates: Partial<AppState>) => void;
  onRefresh: () => void;
  error: string | null;
  hasApiKey: boolean | null;
}) {
  const [localState, setLocalState] = useState(state);

  useEffect(() => {
    setLocalState(state);
  }, [state]);

  const handleSave = () => {
    updateState(localState);
  };

  const handleReset = () => {
    if (window.confirm("Вы уверены, что хотите обнулить все показатели?")) {
      const resetState = {
        deposit: 0,
        withdrawal: 0,
        currentLikes: 0,
        goalLikes: 100,
        videoId: "",
        channelUrl: "",
        isActive: false
      };
      setLocalState(resetState);
      updateState(resetState);
    }
  };

  const toggleActive = () => {
    const nextActive = !localState.isActive;
    const nextState = { ...localState, isActive: nextActive };
    setLocalState(nextState);
    updateState(nextState);
  };

  const widgetUrl = `${window.location.origin}${window.location.pathname}`;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-8 font-sans">
      <div className="max-w-2xl mx-auto space-y-8">
        <header className="flex justify-between items-center border-b border-zinc-800 pb-6">
          <div>
            <h1 className="text-3xl font-black tracking-tight text-white uppercase">Панель Управления</h1>
            <p className="text-zinc-500 text-sm">Настройка виджета для стрима</p>
          </div>
        </header>

        {error && (
          <div className="bg-red-500/10 border border-red-500/50 p-4 rounded-xl flex items-center gap-3 text-red-500 text-sm">
            <AlertCircle className="w-5 h-5 flex-shrink-0" />
            <p>{error}</p>
          </div>
        )}

        {hasApiKey === false && (
          <div className="bg-yellow-500/10 border border-yellow-500/50 p-4 rounded-xl flex items-center gap-3 text-yellow-500 text-xs">
            <AlertCircle className="w-5 h-5 flex-shrink-0" />
            <p>
              <strong>ВНИМАНИЕ:</strong> YouTube API Key не настроен. Используется медленный метод (скрейпинг). 
              Для стабильной работы настройте <code>YOUTUBE_API_KEY</code> в настройках.
            </p>
          </div>
        )}

        <div className="space-y-8">
          <div className="flex gap-4">
            <button 
              onClick={toggleActive}
              className={cn(
                "flex-1 py-6 rounded-2xl font-black text-xl transition-all shadow-xl flex items-center justify-center gap-3",
                localState.isActive 
                  ? "bg-red-600 hover:bg-red-500 text-white shadow-red-900/20" 
                  : "bg-green-600 hover:bg-green-500 text-white shadow-green-900/20"
              )}
            >
              {localState.isActive ? (
                <>
                  <RefreshCw className="w-6 h-6 animate-spin" />
                  ОСТАНОВИТЬ СТРИМ
                </>
              ) : (
                <>
                  <RefreshCw className="w-6 h-6" />
                  ЗАПУСТИТЬ СТРИМ
                </>
              )}
            </button>
          </div>

          <div className="grid grid-cols-2 gap-6">
            <div className="space-y-2">
              <label className="text-xs font-bold text-green-500 uppercase tracking-widest">ДЕПОЗИТ</label>
              <div className="relative">
                <PlusCircle className="absolute left-4 top-1/2 -translate-y-1/2 text-green-500/50 w-5 h-5" />
                <input 
                  type="number"
                  value={localState.deposit}
                  onChange={(e) => setLocalState({ ...localState, deposit: parseInt(e.target.value) || 0 })}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-xl py-4 pl-12 pr-4 text-2xl font-bold focus:outline-none focus:ring-2 focus:ring-green-500/50 transition-all"
                />
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-xs font-bold text-red-500 uppercase tracking-widest">ВЫВОД</label>
              <div className="relative">
                <MinusCircle className="absolute left-4 top-1/2 -translate-y-1/2 text-red-500/50 w-5 h-5" />
                <input 
                  type="number"
                  value={localState.withdrawal}
                  onChange={(e) => setLocalState({ ...localState, withdrawal: parseInt(e.target.value) || 0 })}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-xl py-4 pl-12 pr-4 text-2xl font-bold focus:outline-none focus:ring-2 focus:ring-red-500/50 transition-all"
                />
              </div>
            </div>
          </div>

          <div className="bg-zinc-900/50 border border-zinc-800 p-6 rounded-2xl space-y-6">
            <div className="flex justify-between items-center">
              <h2 className="text-xl font-bold text-white flex items-center gap-2">
                <ThumbsUp className="w-5 h-5 text-yellow-500" />
                ЦЕЛЬ ЛАЙКОВ
              </h2>
              <button 
                onClick={onRefresh}
                className="p-2 hover:bg-zinc-800 rounded-lg transition-colors text-zinc-400 hover:text-white"
                title="Обновить сейчас"
              >
                <RefreshCw className="w-5 h-5" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-6">
              <div className="space-y-2">
                <label className="text-xs font-bold text-zinc-500 uppercase tracking-widest">ТЕКУЩИЕ</label>
                <input 
                  type="number"
                  value={localState.currentLikes}
                  onChange={(e) => setLocalState({ ...localState, currentLikes: parseInt(e.target.value) || 0 })}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-xl py-3 px-4 text-xl font-bold focus:outline-none focus:ring-2 focus:ring-yellow-500/50"
                />
              </div>
              <div className="space-y-2">
                <label className="text-xs font-bold text-zinc-500 uppercase tracking-widest">ЦЕЛЬ</label>
                <input 
                  type="number"
                  value={localState.goalLikes}
                  onChange={(e) => setLocalState({ ...localState, goalLikes: parseInt(e.target.value) || 0 })}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-xl py-3 px-4 text-xl font-bold focus:outline-none focus:ring-2 focus:ring-yellow-500/50"
                />
              </div>
            </div>

            <div className="space-y-4 pt-4 border-t border-zinc-800">
              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="text-xs font-bold text-zinc-500 uppercase tracking-widest">ССЫЛКА НА КАНАЛ (АВТО-ПОИСК)</label>
                  <div className="relative">
                    <Youtube className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-500 w-5 h-5" />
                    <input 
                      type="text"
                      placeholder="Напр: https://www.youtube.com/@ChannelName"
                      value={localState.channelUrl}
                      onChange={(e) => setLocalState({ ...localState, channelUrl: e.target.value })}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-xl py-3 pl-12 pr-4 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                    />
                  </div>
                </div>

                <div className="hidden">
                  <input 
                    type="text"
                    readOnly
                    value={localState.videoId}
                  />
                </div>

                <div className="flex justify-between items-center mt-1">
                  {state.videoId ? (
                    <p className="text-[10px] text-zinc-500 flex items-center gap-1">
                      <span className="w-1.5 h-1.5 bg-red-500 rounded-full animate-pulse" />
                      СТРИМ АКТИВЕН: <span className="text-blue-400 font-mono">{state.videoId}</span>
                    </p>
                  ) : (
                    <p className="text-[10px] text-zinc-500 italic">Стрим не обнаружен</p>
                  )}
                  {state.isActive && (
                    <span className="text-[10px] text-blue-500 font-bold animate-pulse">АВТО-ОБНОВЛЕНИЕ ВКЛ</span>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="flex gap-4">
            <button 
              onClick={handleSave}
              className="flex-1 bg-blue-600 hover:bg-blue-500 text-white font-bold py-4 rounded-xl shadow-lg shadow-blue-900/20 transition-all flex items-center justify-center gap-2"
            >
              <Save className="w-5 h-5" />
              СОХРАНИТЬ
            </button>
            <button 
              onClick={handleReset}
              className="bg-zinc-800 hover:bg-red-900/50 text-zinc-400 hover:text-red-500 font-bold px-6 rounded-xl transition-all border border-zinc-700"
            >
              СБРОС
            </button>
          </div>
        </div>

        <div className="bg-zinc-900/30 border border-zinc-800/50 p-4 rounded-xl space-y-2">
          <p className="text-xs font-bold text-zinc-600 uppercase tracking-widest">ССЫЛКА ДЛЯ OBS</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 bg-black/50 p-2 rounded text-xs text-blue-400 break-all font-mono">
              {widgetUrl}
            </code>
            <a 
              href={widgetUrl} 
              target="_blank" 
              rel="noopener noreferrer"
              className="p-2 hover:bg-zinc-800 rounded-lg text-zinc-500 transition-colors"
            >
              <ExternalLink className="w-4 h-4" />
            </a>
          </div>
          <p className="text-[10px] text-zinc-700 italic">
            * Добавьте эту ссылку как "Браузер" (Browser Source) в OBS Studio.
          </p>
        </div>
      </div>
    </div>
  );
}
