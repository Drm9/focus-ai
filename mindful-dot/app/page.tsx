"use client";

// Add legacy webkit audio context typing without using `any`
declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  PropsWithChildren,
} from "react";
import { motion } from "framer-motion";
import { Settings, Play, Pause, RotateCcw, Volume2, VolumeX } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";

/* -------------------- Utils -------------------- */

const fmt = (s: number): string => {
  const m = Math.floor(s / 60).toString().padStart(2, "0");
  const ss = Math.floor(s % 60).toString().padStart(2, "0");
  return `${m}:${ss}`;
};

type SettingsState = {
  inhale: number;
  hold1: number;
  exhale: number;
  hold2: number;
  dotMin: number;
  dotMax: number;
  cyclesGoal: number;
  chimeOnPhaseChange: boolean;
  chimeOnCycle: boolean;
  volume: number; // 0..1
};

const DEFAULTS: SettingsState = {
  inhale: 4,
  hold1: 2,   // calmer defaults
  exhale: 6,
  hold2: 2,
  dotMin: 40,
  dotMax: 160,
  cyclesGoal: 20,
  chimeOnPhaseChange: false,
  chimeOnCycle: true,
  volume: 0.4,
};

// WebAudio chime (simple sine beep) with strict TS types
function playChime(
  { volume = 0.4, freq = 432, duration = 0.22 }: { volume?: number; freq?: number; duration?: number } = {}
) {
  try {
    const AC: typeof AudioContext | undefined =
      window.AudioContext ?? window.webkitAudioContext;
    if (!AC) return;

    const ctx = new AC();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.frequency.value = freq;
    osc.type = "sine";
    gain.gain.value = volume;

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
    osc.stop(ctx.currentTime + duration + 0.02);
  } catch {
    // ignore audio errors (user gesture may be required before audio)
  }
}

/* -------------------- Phases -------------------- */

const phases = [
  { key: "inhale", label: "Inhale" },
  { key: "hold1", label: "Hold" },
  { key: "exhale", label: "Exhale" },
  { key: "hold2", label: "Hold" },
] as const;

type PhaseKey = typeof phases[number]["key"];

/* -------------------- Main Component -------------------- */

export default function Focus() {
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Start paused; welcome screen shows on every load
  const [running, setRunning] = useState<boolean>(false);
  const [showWelcome, setShowWelcome] = useState<boolean>(true);

  // Sound master toggle
  const [soundOn, setSoundOn] = useState<boolean>(true);

  const [settings, setSettings] = useState<SettingsState>({ ...DEFAULTS });

  const [phaseIndex, setPhaseIndex] = useState<number>(0);
  const [phaseRemaining, setPhaseRemaining] = useState<number>(DEFAULTS.inhale);
  const [cycles, setCycles] = useState<number>(0);

  const [sessionSeconds, setSessionSeconds] = useState<number>(0);
  const sessionStartRef = useRef<number | null>(null);

  // dot position (%)
  const [dotPos, setDotPos] = useState<{ x: number; y: number }>({ x: 50, y: 50 });

  // Recompute phase durations from settings
  const phaseDurations = useMemo<number[]>(
    () => [settings.inhale, settings.hold1, settings.exhale, settings.hold2],
    [settings]
  );

  // Progress percent (cycles vs goal)
  const progressPct = Math.min(
    100,
    Math.round((cycles / Math.max(1, settings.cyclesGoal)) * 100)
  );

  // Dot size animation per phase
  const dotScale = useMemo<{ from: number; to: number }>(() => {
    const min = settings.dotMin;
    const max = settings.dotMax;
    const k: PhaseKey = phases[phaseIndex].key;

    if (k === "inhale") return { from: min, to: max };
    if (k === "exhale") return { from: max, to: min };
    if (k === "hold1") return { from: max, to: max };
    if (k === "hold2") return { from: min, to: min };
    return { from: min, to: min };
  }, [phaseIndex, settings.dotMin, settings.dotMax]);

  // 📍 Keep the dot inside the big circle:
  // randomize polar coords within ~41% radius (the ring is ~82% of width)
  const moveDotRandom = useCallback(() => {
    const MAX_R_PCT = 41;  // circle radius as % (matches ring ~82% diameter)
    const PADDING_PCT = 6; // keep dot away from edge a bit
    const r = Math.random() * (MAX_R_PCT - PADDING_PCT);
    const theta = Math.random() * Math.PI * 2;
    const x = 50 + r * Math.cos(theta);
    const y = 50 + r * Math.sin(theta);
    setDotPos({ x, y });
  }, []);

  // Reset session
  const resetAll = useCallback(() => {
    setRunning(false);
    setPhaseIndex(0);
    setPhaseRemaining(settings.inhale);
    setCycles(0);
    setSessionSeconds(0);
    sessionStartRef.current = null;
    setDotPos({ x: 50, y: 50 });
  }, [settings.inhale]);

  // Toggle start/stop
  const toggle = useCallback(() => {
    setRunning((r) => {
      const next = !r;
      if (next && !sessionStartRef.current) {
        sessionStartRef.current = Date.now();
      }
      return next;
    });
  }, []);

  // Keyboard: Space to toggle
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  // Tick timers
  useEffect(() => {
    if (!running) return;

    const interval = window.setInterval(() => {
      // Session time
      setSessionSeconds((s) => s + 1);

      // Phase countdown second-wise
      setPhaseRemaining((t) => {
        if (t > 1) return t - 1;

        // Phase complete -> advance
        setPhaseIndex((idx) => {
          const nextIdx = (idx + 1) % phases.length;
          const justCompletedExhale = phases[idx].key === "exhale";

          if (settings.chimeOnPhaseChange && soundOn) {
            playChime({ volume: settings.volume, freq: 528, duration: 0.16 });
          }

          if (justCompletedExhale) {
            setCycles((c) => c + 1);
            moveDotRandom();
            if (settings.chimeOnCycle && soundOn) {
              playChime({ volume: settings.volume, freq: 432, duration: 0.22 });
            }
          }

          // Set next phase remaining
          setPhaseRemaining(phaseDurations[nextIdx] || 1);
          return nextIdx;
        });

        return 1; // replaced immediately
      });
    }, 1000);

    return () => window.clearInterval(interval);
  }, [
    running,
    moveDotRandom,
    phaseDurations,
    settings.chimeOnPhaseChange,
    settings.chimeOnCycle,
    settings.volume,
    soundOn,
  ]);

  // If a phase duration is 0, auto-skip it while running
  useEffect(() => {
    if (!running) return;
    if (phaseDurations[phaseIndex] === 0) {
      setPhaseRemaining(1);
      setPhaseIndex((idx) => (idx + 1) % phases.length);
    }
  }, [running, phaseDurations, phaseIndex]);

  const currentPhaseSeconds = Math.max(0.01, phaseDurations[phaseIndex] || 0.01);
  const progressStyle: React.CSSProperties = { width: `${progressPct}%` };
  const phaseLabel = phases[phaseIndex].label;

  /* -------------------- UI -------------------- */

  return (
    <div className="min-h-screen w-full bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 text-slate-100 flex flex-col items-center">

      {/* Welcome screen — always on first render until user starts */}
      {showWelcome && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="max-w-lg w-full rounded-2xl border border-slate-700 bg-slate-900 text-slate-100 p-6 shadow-xl">
            <h2 className="text-2xl font-semibold mb-2 text-center">Welcome to Focus</h2>
            <p className="text-slate-300 text-sm text-center mb-4">
              Keep your eyes on the moving dot. Breathe with the label inside it: <b>Inhale</b>, <b>Hold</b>, <b>Exhale</b>.
              You can change timing, size and sound in the <b>gear</b> (top-right).
            </p>
            <ul className="text-slate-300 text-sm list-disc pl-5 space-y-1 mb-5">
              <li>The dot moves <b>inside the circle</b> after each full breath.</li>
              <li>Press <b>Pause</b> anytime. <kbd className="px-1 py-0.5 bg-slate-800 border border-slate-700 rounded">Space</kbd> also toggles start/pause.</li>
              <li>Use the <b>Sound</b> toggle on the top bar to mute/unmute chimes.</li>
            </ul>
            <div className="flex justify-center">
              <Button
                size="lg"
                className="px-6 py-2 text-base font-semibold"
                onClick={() => {
                  setShowWelcome(false);
                  // Start the session
                  if (!sessionStartRef.current) sessionStartRef.current = Date.now();
                  setRunning(true);
                }}
              >
                START — IMPROVE MY FOCUS
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Top Bar */}
      <div className="w-full max-w-5xl px-4 pt-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="h-8 w-8 rounded-xl bg-slate-800/70 border border-slate-700 grid place-items-center">🎯</div>
          <div>
            <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">Focus</h1>
            <p className="text-xs sm:text-sm text-slate-400">
              Focus your gaze. Sync your breath. Settle your mind.
            </p>
          </div>
        </div>

        {/* Settings Gear */}
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="ghost" className="hover:bg-slate-800/60">
              <Settings className="h-5 w-5" />
              <span className="sr-only">Settings</span>
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-lg bg-slate-900 border border-slate-700">
            <DialogHeader>
              <DialogTitle className="text-slate-100">Session Settings</DialogTitle>
            </DialogHeader>

            <div className="space-y-6 py-2">
              {/* Phase durations */}
              <Section title="Breath Phases (seconds)">
                <Row label="Inhale">
                  <SecondsSlider
                    value={settings.inhale}
                    onChange={(v) => setSettings((s) => ({ ...s, inhale: v }))}
                  />
                </Row>
                <Row label="Hold 1">
                  <SecondsSlider
                    value={settings.hold1}
                    onChange={(v) => setSettings((s) => ({ ...s, hold1: v }))}
                  />
                </Row>
                <Row label="Exhale">
                  <SecondsSlider
                    value={settings.exhale}
                    onChange={(v) => setSettings((s) => ({ ...s, exhale: v }))}
                  />
                </Row>
                <Row label="Hold 2">
                  <SecondsSlider
                    value={settings.hold2}
                    onChange={(v) => setSettings((s) => ({ ...s, hold2: v }))}
                  />
                </Row>
              </Section>

              {/* Dot size */}
              <Section title="Calming Dot Size (px)">
                <Row label={`Min (${settings.dotMin}px)`}>
                  <Slider
                    value={[settings.dotMin]}
                    onValueChange={([v]) =>
                      setSettings((s) => ({ ...s, dotMin: Math.min(v, s.dotMax - 10) }))
                    }
                    min={24}
                    max={220}
                    step={2}
                  />
                </Row>
                <Row label={`Max (${settings.dotMax}px)`}>
                  <Slider
                    value={[settings.dotMax]}
                    onValueChange={([v]) =>
                      setSettings((s) => ({ ...s, dotMax: Math.max(v, s.dotMin + 10) }))
                    }
                    min={40}
                    max={300}
                    step={2}
                  />
                </Row>
              </Section>

              {/* Cycles goal */}
              <Section title="Session Goal">
                <Row label={`Cycles Goal (${settings.cyclesGoal})`}>
                  <Slider
                    value={[settings.cyclesGoal]}
                    onValueChange={([v]) => setSettings((s) => ({ ...s, cyclesGoal: v }))}
                    min={5}
                    max={100}
                    step={1}
                  />
                </Row>
              </Section>

              {/* Audio */}
              <Section title="Audio Cues">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <ToggleRow
                    checked={settings.chimeOnPhaseChange}
                    onCheckedChange={(val) =>
                      setSettings((s) => ({ ...s, chimeOnPhaseChange: val }))
                    }
                    label="Chime on phase change"
                  />
                  <ToggleRow
                    checked={settings.chimeOnCycle}
                    onCheckedChange={(val) =>
                      setSettings((s) => ({ ...s, chimeOnCycle: val }))
                    }
                    label="Chime at end of cycle"
                  />
                </div>
                <Row label={`Volume (${Math.round(settings.volume * 100)}%)`}>
                  <Slider
                    value={[settings.volume * 100]}
                    onValueChange={([v]) => setSettings((s) => ({ ...s, volume: v / 100 }))}
                    min={0}
                    max={100}
                    step={1}
                  />
                </Row>
              </Section>

              <div className="flex items-center justify-between pt-2">
                <Button
                  variant="secondary"
                  className="bg-slate-200 text-slate-900 hover:bg-slate-100 border border-slate-300"
                  onClick={() => setSettings({ ...DEFAULTS })}
                >
                  Restore Defaults
                </Button>
                <Button variant="destructive" onClick={resetAll}>
                  <RotateCcw className="h-4 w-4 mr-2" /> Reset Session
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {/* Main stage */}
      <div className="w-full max-w-5xl px-4 pb-6 mt-4">
        <Card className="bg-slate-900/60 border-slate-800">
          <CardContent className="p-0">
            {/* HUD */}
            <div className="px-4 pt-4 pb-3 flex flex-wrap items-center gap-3 justify-between">
              <div className="flex items-center gap-4">
                <Badge label={`Phase: ${phaseLabel}`} />
                <Badge
                  label={`Phase Left: ${
                    phaseDurations[phaseIndex] ? `${phaseRemaining}s` : "—"
                  }`}
                  subtle
                />
                <Badge label={`Cycle: ${cycles}/${settings.cyclesGoal}`} subtle />
              </div>
              <div className="flex items-center gap-2">
                <Badge label={`Session: ${fmt(sessionSeconds)}`} />

                {/* Sound toggle */}
                <Button
                  size="sm"
                  variant={soundOn ? "secondary" : "outline"}
                  className={soundOn ? "bg-slate-200 text-slate-900" : ""}
                  onClick={() => setSoundOn(v => !v)}
                  title={soundOn ? "Sound: On" : "Sound: Off"}
                >
                  {soundOn ? <Volume2 className="h-4 w-4 mr-1" /> : <VolumeX className="h-4 w-4 mr-1" />}
                  {soundOn ? "Sound On" : "Sound Off"}
                </Button>

                {/* Start/Pause */}
                <Button size="sm" onClick={toggle} className="ml-1">
                  {running ? (
                    <span className="inline-flex items-center">
                      <Pause className="h-4 w-4 mr-1" />
                      Pause
                    </span>
                  ) : (
                    <span className="inline-flex items-center">
                      <Play className="h-4 w-4 mr-1" />
                      Start
                    </span>
                  )}
                </Button>

                {/* Reset — high contrast */}
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={resetAll}
                >
                  <RotateCcw className="h-4 w-4 mr-1" />
                  Reset
                </Button>
              </div>
            </div>

            {/* Progress bar */}
            <div className="h-2 w-full bg-slate-800/80">
              <div className="h-full bg-sky-400 transition-all" style={progressStyle} />
            </div>

            {/* Breathing field */}
            <div
              ref={containerRef}
              className="relative h-[58vh] sm:h-[62vh] md:h-[66vh] w-full overflow-hidden grid place-items-center"
            >
              {/* Instructional ring */}
              <div className="absolute inset-0 pointer-events-none">
                <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-slate-800 w-[82%] aspect-square" />
              </div>

              {/* Calming Dot (center label & stays inside circle) */}
              <motion.div
                aria-label="Calming dot"
                role="img"
                className="absolute rounded-full shadow-2xl ring-1 ring-slate-700 bg-gradient-to-br from-sky-300 to-blue-500 grid place-items-center"
                animate={{
                  left: `${dotPos.x}%`,
                  top: `${dotPos.y}%`,
                  width: dotScale.to,
                  height: dotScale.to,
                }}
                initial={{
                  left: `${dotPos.x}%`,
                  top: `${dotPos.y}%`,
                  width: dotScale.from,
                  height: dotScale.from,
                }}
                transition={{ duration: currentPhaseSeconds, ease: "easeInOut" }}
                style={{ translateX: "-50%", translateY: "-50%" }}
              >
                <span className="select-none text-slate-900/90 font-medium text-sm sm:text-base">
                  {phaseLabel}
                </span>
              </motion.div>

              {/* Caption — moved to TOP */}
              <div className="absolute top-6 w-full flex items-center justify-center text-slate-300 text-sm">
                <p className="px-3 py-1 rounded-full bg-slate-800/60 border border-slate-700/70 backdrop-blur-sm">
                  Gently {phaseLabel.toLowerCase()}… keep your eyes on the dot
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Footnote */}
        <div className="text-center text-xs text-slate-500 mt-3">
          Tip: Press{" "}
          <kbd className="px-1 py-0.5 bg-slate-800 border border-slate-700 rounded">
            Space
          </kbd>{" "}
          to start/pause
        </div>
      </div>
    </div>
  );
}

/* -------------------- UI helpers with types -------------------- */

function Section({ title, children }: PropsWithChildren<{ title: string }>) {
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-slate-200">{title}</h3>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

function Row({ label, children }: PropsWithChildren<{ label: string }>) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-5 gap-3 items-center">
      <Label className="text-slate-300 sm:col-span-2">{label}</Label>
      <div className="sm:col-span-3">{children}</div>
    </div>
  );
}

function ToggleRow({
  label,
  checked,
  onCheckedChange,
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-slate-700/70 bg-slate-800/40 px-3 py-2">
      <Label className="text-slate-300">{label}</Label>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}

function SecondsSlider({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <Slider
        value={[value]}
        onValueChange={([v]) => onChange(v)}
        min={0}
        max={20}
        step={1}
        className="flex-1"
      />
      <span className="w-10 text-right text-slate-300 tabular-nums">{value}s</span>
    </div>
  );
}

function Badge({ label, subtle = false }: { label: string; subtle?: boolean }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium border ${
        subtle
          ? "bg-slate-800/50 border-slate-700 text-slate-300"
          : "bg-sky-500/15 border-sky-700/40 text-sky-300"
      }`}
    >
      {label}
    </span>
  );
}
