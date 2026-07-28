// The entry point for anyone reaching this library through a bundler or an
// `import` — React, Vite, Next, plain Node with a DOM.
//
// The two consuming paths need two different files, and neither can be the
// other. `exact-video-engine.js` in the repository root is a CLASSIC SCRIPT:
// build.mjs concatenates src/ and strips the module syntax, so it defines
// globals and exports nothing — what a `<script>` tag next to mp4box.js wants,
// and what `import` cannot use. This file is the other side: the same public
// surface, named once, from a path that is part of the contract, so no consumer
// has to import from src/whichever-file-happens-to-hold-it.
//
// Add an export here whenever src/ gains one a host should be able to reach.
//
// Keep this file OUT of src/: build.mjs requires every module there to appear in
// MODULE_ORDER, and a barrel of pure re-exports contributes nothing to a
// concatenation — its whole content is the module syntax the build strips.
//
// Indexing an MP4 or MOV needs mp4box.js, which this engine reads off the global
// scope (`MP4Box` and `DataStream`) rather than importing. That is why mp4box is
// a peer dependency: installing it is necessary and not sufficient, and it has
// to be put in scope.
//
//     import 'mp4box';                       // or a <script> tag, or...
//     globalThis.MP4Box = MP4Box;            // ...however your bundler exposes it
//     import { createBestEngine } from 'exact-video-engine.js';
//
// Every other container -- WebM/MKV, AVI, Ogg -- is indexed by this engine's own
// parsers and needs nothing of the sort.

// The ladder: hand it a source and get back whichever engine can play it best.
// This is the entry point almost every host wants.
export { createBestEngine } from './src/create-best-engine.js';

// The two engines behind it, for a host that wants to choose one outright.
export { VideoEngine } from './src/video-engine.js';
export { NativeVideoEngine } from './src/native-video-engine.js';

// The frame table itself, for a host that wants the index without an engine —
// and the one error that means a clip's frame numbers cannot be trusted.
export { ContainerIndex, CertifiedPrefixViolationError } from './src/container-index.js';

// Reading a source over byte ranges, and the budget error a full-file indexing
// pass throws when it runs out of time or bytes.
export { UrlRangeReader, FileRangeReader, createRangeReader } from './src/range-readers.js';
export { IndexBudgetExceededError, formatProgress } from './src/matroska.js';

// Predicting format trouble without attempting playback — for a host flagging an
// upload for server-side transcoding, say.
export {
  detectBrowserEngine, isTenBitHevc, webCodecsMayFailMidStream,
} from './src/decode-support.js';

// What `engine.codecString` reads for a clip whose frames are whole JPEG images.
// WebCodecs registers no codec string for Motion JPEG, so this marker is ours.
export { MOTION_JPEG_CODEC } from './src/image-frame-decoder.js';

// Why a clip could not be played, in a form a host can branch on rather than
// regular-expression out of a sentence. `createBestEngine` throws an
// UnplayableClipError for every load-time refusal; `reason` is one of
// UNPLAYABLE_REASONS. describeCodec turns a codec string into a name a person
// recognizes, for a host writing its own message instead of showing ours.
export { UnplayableClipError, UNPLAYABLE_REASONS, describeCodec } from './src/unplayable-clip.js';
