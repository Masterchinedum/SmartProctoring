import type { PrivacyNoticeDTO } from './api';

export const PRIVACY_NOTICE_VERSION = '2026-09-24';

/** Builds the candidate-facing notice of what is monitored and what evidence is kept. */
export function buildPrivacyNotice(opts: {
  retentionDays: number;
  contact: string;
  orgName: string;
  idPhotoComparison: boolean;
  /** Name of the external face-comparison provider when the organisation enabled one (docs/EXTERNAL_VERIFIER.md). */
  externalVerifier?: string | null;
}): PrivacyNoticeDTO {
  const monitored = [
    'Your webcam image is analysed in your browser while the exam is active (face presence, number of people, head direction, visible phones or other devices, camera problems).',
    'Your face is compared with the identity reference taken at the start of the exam, at intervals and whenever you return after a pause, a camera interruption, or leaving the camera view.',
    'Exam-page events: leaving the exam tab, the window losing focus, leaving fullscreen, and copy/paste attempts.',
    'Connection status, pause and resume times, and your answers.',
  ];
  if (opts.idPhotoComparison) monitored.push('Your live image is compared with the identity photo approved by the exam administrator.');
  if (opts.externalVerifier) {
    monitored.push(
      `For some identity checks (for example at the start, when you resume, or if a possible change of person is detected), your camera image and the image it is compared with (your identity reference or the approved identity photo) may be sent to ${opts.externalVerifier}, an external face-comparison service used by ${opts.orgName}, for an independent second comparison. Its result is used together with our own comparison; it never decides on its own that you are a different person.`,
    );
  }
  return {
    version: PRIVACY_NOTICE_VERSION,
    retentionDays: opts.retentionDays,
    contact: opts.contact,
    monitored,
    stored: [
      'A protected identity reference derived from your face (a numeric template plus reference images), encrypted at rest.',
      'Webcam screenshots taken only at moments when something was observed (for example, a second person in view), encrypted at rest.',
      'The camera images taken during the readiness check and the checks when you resume or reconnect, and identity images taken during the exam that did not clearly match your identity reference, encrypted at rest as evidence for review.',
      'A timeline of observations, pauses, resumes, identity checks and technical events.',
    ],
    notStored: [
      'No continuous video or audio recording.',
      'No screen recording, and no monitoring of other applications, other monitors or other devices.',
      'No clipboard contents.',
    ],
    sections: [
      {
        heading: 'Why we monitor',
        body: `${opts.orgName} uses automated proctoring to help ensure the exam is taken by the registered candidate under the exam’s rules. The system reports observations for human review; it does not decide that anyone cheated.`,
      },
      {
        heading: 'Who can see your data',
        body: opts.externalVerifier
          ? `Only authorised exam administrators and reviewers. Every access to screenshots and identity images is logged. Face images used for a second comparison are also processed by ${opts.externalVerifier} for that comparison.`
          : 'Only authorised exam administrators and reviewers. Every access to screenshots and identity images is logged.',
      },
      {
        heading: 'How long it is kept',
        body: `Screenshots, check images and identity references are deleted ${opts.retentionDays} days after your exam ends, unless they are subject to a legal hold (for example an open appeal). Your identity reference is never used for any other exam or purpose.`,
      },
      {
        heading: 'Pausing',
        body: 'When you pause, monitoring stops completely and nothing is observed until you resume. On resume we repeat the camera and identity checks.',
      },
      {
        heading: 'Your choices',
        body: `You must consent to proceed with a proctored exam. If you do not consent, or need an accommodation, contact ${opts.contact} before starting.`,
      },
    ],
  };
}
