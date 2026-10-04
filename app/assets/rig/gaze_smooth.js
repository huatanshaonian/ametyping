// Layered eye for smooth gaze (made by tools/gaze_split.py from the 8 painted gaze patches): the eye white, one iris disc
// that slides under the lids, and the lid lines on top. x/y/w/h = the patch box in rig px, iris* = the disc at rest,
// pupil = the pupil centre at rest, offset = how far the pupil sits from rest in each painted direction (all patch px).
// Foreshortening, measured on the painted patches (pupil-to-rim distance along the gaze axis): at a full sideways turn
// (turn px from rest) the rim on the side she looks toward comes in by `squeeze`, the far side grows by `stretch`;
// the neutral eye painted on the head is `restGrow` bigger than the turned ones.
window.GAZE_SMOOTH = {"x": 394, "y": 552, "w": 116, "h": 71, "irisX": 14, "irisY": -2, "irisW": 77, "irisH": 69, "pupil": [57, 30],
  "offset": {"r": [25, 0], "dr": [26, 5], "d": [3, 12], "dl": [-17, 7], "l": [-23, 0], "ul": [-17, -10], "u": [2, -10], "ur": [19, -5]},
  "turn": 25, "squeeze": 0.33, "stretch": 0.08, "restGrow": 0.08,
  "speed": 28};   // how fast the eyes catch up with the cursor (1/s; the head follows at 5): 28 = most of the way in ~80 ms
