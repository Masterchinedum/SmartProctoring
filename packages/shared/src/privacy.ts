import type { PrivacyNoticeDTO } from './api';
import type { RecordingPlan } from './policy';

/** Version of the notice for exams that do not record (the wording candidates have seen since 2026-10-21). */
export const PRIVACY_NOTICE_VERSION = '2026-10-21';
/**
 * Version of the notice for exams that record the exam (policy.recording): the same notice plus what is recorded,
 * how long it is kept and who can watch it. A separate version, so the consent record shows which notice the
 * candidate accepted — a consent given to the notice without recording does not cover a recording.
 */
export const RECORDING_NOTICE_VERSION = '2026-10-22-recording';

/** The notice version a candidate must accept for an exam with this recording plan. */
export function noticeVersionFor(recording: Pick<RecordingPlan, 'any'> | null | undefined): string {
  return recording?.any ? RECORDING_NOTICE_VERSION : PRIVACY_NOTICE_VERSION;
}

/** Whether a consent given to notice `version` covers an exam with this recording plan. */
export function consentCoversRecording(version: string | null | undefined, recording: Pick<RecordingPlan, 'any'> | null | undefined): boolean {
  return !recording?.any || version === RECORDING_NOTICE_VERSION;
}

/** "your webcam video, the sound from your microphone and your entire screen" — what a recording plan records. */
export function recordedThings(r: Pick<RecordingPlan, 'camera' | 'audio' | 'screen'>): string {
  const parts = [r.camera ? 'your webcam video' : null, r.audio ? 'the sound from your microphone' : null, r.screen ? 'your entire screen' : null].filter((x): x is string => !!x);
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** Builds the candidate-facing notice of what is monitored and what evidence is kept. */
export function buildPrivacyNotice(opts: {
  retentionDays: number;
  contact: string;
  orgName: string;
  idPhotoComparison: boolean;
  /** Name of the external face-comparison provider when the organisation enabled one (docs/EXTERNAL_VERIFIER.md). */
  externalVerifier?: string | null;
  /** policy.camera.enabled (default true): false = the exam runs without a camera (an accommodation). */
  camera?: boolean;
  /** policy.identity.verification (default 'automatic'): 'staff' = a staff member verifies identity, no face comparison. */
  identityVerification?: 'automatic' | 'staff';
  /** What the exam records (recordingPlan(policy)); absent or nothing recorded = the notice without recording. */
  recording?: RecordingPlan | null;
}): PrivacyNoticeDTO {
  const camera = opts.camera !== false;
  const automatic = camera && opts.identityVerification !== 'staff';
  // Exams without recording keep exactly the wording of PRIVACY_NOTICE_VERSION.
  const rec = opts.recording?.any ? opts.recording : null;
  const recorded = rec ? recordedThings(rec) : '';
  const monitored = [
    ...(rec ? [`The whole exam is recorded: ${recorded}, from the moment you start the exam until it ends. Recording stops while the exam is paused or on hold.`] : []),
    ...(rec?.screen
      ? [
          'Before the exam starts you are asked to share your entire screen (not just a window or a tab). Everything shown on that screen during the exam is recorded, including notifications and other applications. If sharing stops, the exam is covered until you share your screen again, and this is recorded for the exam administrator.',
        ]
      : []),
    ...(camera ? ['Your webcam image is analysed in your browser while the exam is active (face presence, number of people, head direction, visible phones or other devices, camera problems).'] : []),
    automatic
      ? 'Your face is compared with the identity reference taken at the start of the exam, at intervals and whenever you return after a pause, a camera interruption, or leaving the camera view.'
      : `A staff member verifies your identity before the exam starts${camera ? '' : '. No camera is used for your exam'}; no automated face comparison is made.`,
    'Exam-page events: leaving the exam tab, the window losing focus, leaving fullscreen, and copy/paste attempts.',
    ...(camera
      ? [
          'When you last typed, used the mouse or scrolled on the exam page (timing only — never which keys you press or what you type). Your browser uses this to learn where you look while working, so that reading, looking at your keyboard while typing, or using a monitor beside your camera is not mistaken for looking away. It stays on your device and is not sent anywhere.',
        ]
      : []),
    'Connection status, pause and resume times, and your answers.',
  ];
  if (automatic && opts.idPhotoComparison) monitored.push('Your live image is compared with the identity photo approved by the exam administrator.');
  if (automatic && opts.externalVerifier) {
    monitored.push(
      `For some identity checks (for example at the start, when you resume, or if a possible change of person is detected), your camera image and the image it is compared with (your identity reference or the approved identity photo) may be sent to ${opts.externalVerifier}, an external face-comparison service used by ${opts.orgName}, for an independent second comparison. Its result is used together with our own comparison; it never decides on its own that you are a different person.`,
    );
  }
  const recordingStored = rec
    ? `The recording of your exam (${recorded}), stored in short parts and encrypted at rest. ${
        rec.audio && rec.screen
          ? 'Anything said or heard in your room and anything shown on your screen'
          : rec.audio
            ? 'Anything said or heard in your room'
            : rec.screen
              ? 'Anything shown on your screen'
              : 'Anything in view of your webcam'
      } while the exam runs is part of it, so close applications and notifications showing personal information before you start.`
    : null;
  return {
    version: noticeVersionFor(rec),
    ...(rec ? { recording: { camera: rec.camera, audio: rec.audio, screen: rec.screen } } : {}),
    retentionDays: opts.retentionDays,
    contact: opts.contact,
    monitored,
    stored: [
      ...(recordingStored ? [recordingStored] : []),
      ...(automatic
        ? [
            'A protected identity reference derived from your face (a numeric template plus reference images), encrypted at rest.',
            'Webcam screenshots taken only at moments when something was observed (for example, a second person in view), encrypted at rest.',
            'The camera images taken during the readiness check and the checks when you resume or reconnect, and identity images taken during the exam that did not clearly match your identity reference, encrypted at rest as evidence for review.',
          ]
        : camera
          ? ['Webcam screenshots taken only at moments when something was observed (for example, a second person in view), encrypted at rest. No face template or identity images are kept.']
          : ['No camera images of any kind.']),
      automatic ? 'A timeline of observations, pauses, resumes, identity checks and technical events.' : 'A timeline of observations, pauses, resumes, the staff identity verification and technical events.',
    ],
    notStored: rec
      ? [
          'Nothing is recorded before you start the exam, while it is paused or on hold, or after it ends.',
          ...(rec.camera ? [] : ['No video of you from your webcam.']),
          ...(rec.audio ? [] : ['No sound from your microphone.']),
          rec.screen
            ? 'Only the one screen you share is recorded: other monitors and other devices are not.'
            : 'No screen recording, and no monitoring of other applications, other monitors or other devices.',
          'No clipboard contents.',
          rec.screen
            ? 'No keystroke logging: which keys you press and where your mouse pointer is are not recorded separately (the screen recording shows what appears on your screen).'
            : 'No keystroke logging: which keys you press and where your mouse pointer is are never recorded.',
        ]
      : [
          'No continuous video or audio recording.',
          'No screen recording, and no monitoring of other applications, other monitors or other devices.',
          'No clipboard contents.',
          'No keystroke logging: which keys you press and where your mouse pointer is are never recorded.',
        ],
    sections: [
      {
        heading: 'Why we monitor',
        body: `${opts.orgName} uses automated proctoring to help ensure the exam is taken by the registered candidate under the exam’s rules. The system reports observations for human review; it does not decide that anyone cheated.`,
      },
      {
        heading: 'Who can see your data',
        body:
          (opts.externalVerifier
            ? `Only authorised exam administrators and reviewers. Every access to screenshots and identity images is logged. Face images used for a second comparison are also processed by ${opts.externalVerifier} for that comparison.`
            : 'Only authorised exam administrators and reviewers. Every access to screenshots and identity images is logged.') +
          (rec ? ' They can also watch the recording of your exam; every time they open part of it is logged.' : ''),
      },
      {
        heading: 'How long it is kept',
        body:
          (automatic
            ? `Screenshots, check images and identity references are deleted ${opts.retentionDays} days after your exam ends, unless they are subject to a legal hold (for example an open appeal). Your identity reference is never used for any other exam or purpose.`
            : `Any screenshots are deleted ${opts.retentionDays} days after your exam ends, unless they are subject to a legal hold (for example an open appeal).`) +
          (rec ? ` The recording of your exam is kept in the same place as these images and deleted at the same time: ${opts.retentionDays} days after your exam ends, unless it is subject to a legal hold.` : ''),
      },
      {
        heading: 'Pausing',
        body: rec
          ? automatic
            ? 'When you pause, monitoring and recording stop completely and nothing is observed or recorded until you resume. On resume we repeat the camera and identity checks.'
            : 'When you pause, monitoring and recording stop completely and nothing is observed or recorded until you resume.'
          : automatic
            ? 'When you pause, monitoring stops completely and nothing is observed until you resume. On resume we repeat the camera and identity checks.'
            : 'When you pause, monitoring stops completely and nothing is observed until you resume.',
      },
      {
        heading: 'Your choices',
        body: `You must consent to proceed with a proctored exam. If you do not consent, or need an accommodation, contact ${opts.contact} before starting. You can withdraw your consent at any time, also during the exam (open this notice and choose “Withdraw my consent”): your exam then ends without a score, the images${rec ? ', the recording' : ''} and identity data recorded for it are deleted straight away, and ${opts.orgName} will contact you about another way to take it.`,
      },
    ],
  };
}
