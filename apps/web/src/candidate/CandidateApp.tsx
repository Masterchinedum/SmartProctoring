import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { CheckPurpose } from '@sp/shared';
import { LiveAnnouncer } from '../lib/LiveAnnouncer';
import { useCandidateAnnouncements } from './announcements';
import { CandidateController, isVerifiedInstance } from './controller';
import { ControllerProvider, useController, useSnapshot } from './context';
import { CheckFlow } from './check/CheckFlow';
import { ExamScreen } from './screens/exam/ExamScreen';
import { EndedScreen, FatalScreen, HoldScreen, LoadingScreen, PausedScreen, ReadyScreen } from './screens/StatusScreens';
import { WelcomeScreen } from './screens/Welcome';
import './candidate.css';

/**
 * Candidate app: /take/:token/*  (the token from the invite link is the Bearer credential).
 * One controller per token and page load; it survives React StrictMode's double mount.
 */

let current: CandidateController | null = null;

function controllerFor(token: string): CandidateController {
  if (current && current.token === token) return current;
  current?.dispose();
  current = new CandidateController(token);
  return current;
}

export default function CandidateApp() {
  const { token = '' } = useParams();
  const [ctrl] = useState(() => controllerFor(token));
  const c = ctrl.token === token ? ctrl : controllerFor(token);

  useEffect(() => {
    void c.load();
  }, [c]);

  useEffect(() => {
    // Each screen sets its own title (ScreenHeading); this is the fallback while loading.
    document.title = 'Exam — SmartProctoring';
    document.documentElement.lang ||= 'en';
    // Do not leak the access token through the Referer header to anything the page loads.
    let meta = document.querySelector<HTMLMetaElement>('meta[name="referrer"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'referrer';
      document.head.appendChild(meta);
    }
    meta.content = 'no-referrer';
  }, []);

  return (
    <ControllerProvider controller={c}>
      <LiveAnnouncer />
      <CandidateRouter />
    </ControllerProvider>
  );
}

function CandidateRouter() {
  const ctrl = useController();
  const snap = useSnapshot();
  useCandidateAnnouncements();
  // Local flow flags (buttons on paused / hold screens start a check).
  const [checkRequest, setCheckRequest] = useState<CheckPurpose | null>(null);

  const status = snap.state?.session.status;
  useEffect(() => {
    // A started check is only meaningful for the status it was started from.
    if (checkRequest === 'resume' && status !== 'paused') setCheckRequest(null);
    if (checkRequest === 'reverify' && status !== 'on_hold') setCheckRequest(null);
  }, [status, checkRequest]);

  if (snap.fatal) return <FatalScreen kind={snap.fatal.kind} message={snap.fatal.message} />;
  if (!snap.state) return <LoadingScreen error={snap.loadError} onRetry={() => void ctrl.load()} />;

  const s = snap.state;
  const st = s.session.status;
  if (st === 'submitted' || st === 'terminated') return <EndedScreen />;
  if (!s.consent.accepted) return <WelcomeScreen />;

  switch (st) {
    case 'invited':
      return <CheckFlow key="initial" purpose={s.session.requiredCheck ?? 'initial'} />;
    case 'ready':
      if (s.session.requiredCheck) return <CheckFlow key={`ready-${s.session.requiredCheck}`} purpose={s.session.requiredCheck} />;
      return <ReadyScreen />;
    case 'active':
      if (!isVerifiedInstance(s, ctrl.instanceId)) return <CheckFlow key="reconnect" purpose={s.session.requiredCheck ?? 'reconnect'} />;
      return <ExamScreen />;
    case 'paused':
      if (checkRequest === 'resume') return <CheckFlow key="resume" purpose="resume" onCancel={() => setCheckRequest(null)} />;
      return <PausedScreen onResume={() => setCheckRequest('resume')} />;
    case 'on_hold':
      if (checkRequest === 'reverify' && s.session.hold?.canReverify) return <CheckFlow key="reverify" purpose="reverify" onCancel={() => setCheckRequest(null)} />;
      return <HoldScreen onReverify={() => setCheckRequest('reverify')} />;
    default:
      return <LoadingScreen error={`Unknown exam status: ${String(st)}`} onRetry={() => void ctrl.load()} />;
  }
}
