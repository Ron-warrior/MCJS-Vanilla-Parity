// Single-engine boot (1.19.4 mainline).
//
// ?voicebridge=<host>[:<port>] boots voice ONLY (no game): an Eagler player
// on that same server opens the link on any device, taps JOIN, and talks
// with our players (matched by name for proximity). Everything else boots
// the game.
var isBridge = false;
try {
  var q0 = new URLSearchParams(location.search);
  var h0 = String(location.hash || "");
  isBridge = q0.has("voicebridge") || h0.indexOf("voicebridge") !== -1;
} catch (e) { isBridge = false; }
if (isBridge) {
  await import("./mc1194/voice.js");
} else {
  await import("./mc1194/boot1194.js");
}
