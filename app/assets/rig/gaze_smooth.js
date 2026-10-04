// Layered eye for smooth gaze (made by tools/gaze_split.py from the 8 painted gaze patches): the eye white, one iris disc
// that slides under the lids, and the lid lines on top. x/y/w/h = the patch box in rig px, iris* = the disc at rest,
// offset = how far the iris sits from rest in each painted direction (rig px).
window.GAZE_SMOOTH = {"x": 394, "y": 552, "w": 116, "h": 71, "irisX": 14, "irisY": -2, "irisW": 77, "irisH": 69,
  "offset": {"r": [25, 0], "dr": [26, 5], "d": [3, 12], "dl": [-17, 7], "l": [-23, 0], "ul": [-17, -10], "u": [2, -10], "ur": [19, -5]}};
