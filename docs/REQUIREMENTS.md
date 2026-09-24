# Product requirements (verbatim from the product owner)

## Smart proctoring for online exams
I want a proctoring system that monitors an exam as it happens, preserves the candidate’s exam session when they pause, and checks that the same person continues when they resume. It should turn observable events into timely, reviewable alerts with screenshots. It should distinguish potential integrity problems from ordinary changes and technical difficulties.

### Starting an exam
Before the exam starts, the candidate should see their webcam preview and complete a readiness check. The system should confirm that the camera works, one face is visible, and the image is clear enough for monitoring.

At this point, the system should establish a protected reference for the candidate’s face. If the exam already has an approved identity photo, it may also compare the live candidate with that photo. This initial check should include a reasonable way to establish that a live person is in front of the camera, rather than simply accepting a photograph held up to it.

The reference is for checking whether the same person continues the exam. It should not be replaced automatically whenever someone appears in front of the camera; otherwise, a substitute could become the new reference.

### Monitoring during the exam
While the exam is active, I want the system to recognize:

* A missing candidate: No face is visible for a sustained period, including when the candidate leaves and later returns.
* More than one person: Another face enters the camera view, whether briefly or for an extended period.
* A possible person swap: The face now taking the exam appears to belong to someone other than the person who started it. This check matters after the candidate leaves the frame, after a camera interruption, and throughout the active exam—not only after a formal pause.
* Looking away or down: Sustained or repeated head turns and apparent gaze away from the exam screen.
* Unusual movement: The candidate repeatedly moves out of view or far from their normal position.
* An obstructed view: The candidate’s face is covered, cut off, or too unclear for the system to assess.
* Possible use of another device or outside materials: For example, a visible phone, another person’s assistance, or repeated attention toward something off screen. These should be reported only when the visual evidence supports the observation.
* Camera integrity problems: A disconnected camera, frozen image, covered lens, unusable lighting, or a camera feed that may be a replay or otherwise substituted.

The system should also record events available from the exam page, such as switching away from the exam tab or leaving required fullscreen mode. It should not claim to detect activity on another monitor, another device, or elsewhere in the room when the available camera and browser data cannot establish it.

A brief glance or one poor video frame should not generate a flag. The system should consider duration, repetition, confidence, and the candidate’s normal position. An ongoing issue should appear as one event with a start and end time, not dozens of duplicate alerts.

### Pausing and resuming later
A candidate must be able to pause an exam and resume it later, including after closing the browser. Their answers, exam progress, remaining time, and proctoring history should be preserved. The exam’s rules should determine whether the timer stops during a pause and whether a pause needs a reason or approval.

The timeline should show precisely when the exam was paused and resumed. If monitoring stops during the pause, the system should mark that period as unobserved. It should not generate behavioral flags or make claims about what happened during that time.

Before the candidate can continue on resume, the system should repeat the camera readiness and live-person checks and compare the person now present with the protected identity reference from the start of the exam. It should do this even if the candidate resumes hours or days later, in a different room, or with a different camera.

A change in clothing, hairstyle, background, camera angle, or brightness is not itself a violation. Those details may be recorded as context, but they should not be used as proof that the person changed. The important question is whether the candidate’s identity still matches. If the image is too poor for a dependable comparison, the result should be “unable to verify” and the candidate should be guided to improve the view. If there is strong evidence of a different person, the exam should be held for the configured verification or administrator review process, with before-and-after evidence available.

The same identity-continuity check should happen when a face disappears and returns during an active exam, or when the camera disconnects and reconnects. A formal pause should not be the only opportunity to catch a swap.

### Alerts and evidence
An administrator should receive meaningful events in near real time. Each event should say what was observed, when it began, how long it lasted, and how confident the system is. It should include a webcam screenshot from the relevant moment.

For a possible person swap, the review view should include comparable images of the original candidate and the person who appeared later, along with the surrounding timeline: whether the exam had been paused, the face had left the frame, or the camera had disconnected. For a multiple-person event, the evidence should show the camera view containing the additional person.

The system should distinguish among:

* Potential integrity events, such as a possible identity mismatch or multiple people in view
* Uncertain observations, such as a face that cannot be verified because of poor lighting
* Neutral session changes, such as pausing, resuming, changing cameras, or moving to a brighter room
* Technical problems, such as lost camera permission or a reporting outage

If the connection fails, events should retain their original timestamps and be delivered when possible without creating duplicates. The candidate and administrator should both be able to see that live reporting is interrupted.

### Administrator dashboard and final report
The administrator should be able to see active, paused, disconnected, and completed exams; each candidate’s latest monitoring status; and new flags as they arrive. Opening an exam should show a chronological timeline of pauses, resumes, identity checks, camera issues, and behavioral events.

The administrator should be able to open screenshots, compare images for a possible swap, filter events, add notes, dismiss false positives, and mark events as reviewed. The final report should summarize what happened across the entire exam, including every active period and every pause and resume.

The system should report observations such as “a different face may have appeared after resume” rather than automatically declaring that cheating occurred. A person who cannot be verified because of lighting should not be labeled as a different person. The administrator needs enough evidence and context to make that distinction.

### Privacy and reliability
Candidates should know what is monitored and what evidence is kept. Identity references and screenshots should be protected, accessible only to authorized reviewers, and deleted according to a defined retention policy. The system should not need to retain continuous video by default.

Accuracy should be measured separately for each detection, especially person-swap detection and false identity mismatches. It should be tested across lighting changes, different cameras, glasses, hairstyles, clothing changes, backgrounds, and pauses of different lengths. Where the system cannot reach a dependable conclusion, it should say so clearly and route the case for human review.

---
Constraints from the owner: commercial product — no code or models with non-commercial or copyleft-incompatible licenses; functionality over UI polish; must be launch-ready, not boilerplate.
