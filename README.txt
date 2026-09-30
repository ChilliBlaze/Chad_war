SPHERICAL BATTLEFIELD — MULTIPLAYER

Run locally:
  node server.js
Then open http://localhost:8080

Controls:
  WASD       move
  Mouse      look (pointer lock)
  Left click attack / shoot
  Right click aim
  E          weapon wheel
  F          first/third person
  G          emote wheel
  Space      jump
  Q          crouch
  Shift      sprint
  Esc        release pointer lock

Multiplayer additions:
- Health, names and kill-streak leaderboard sync through the server.
- Rifle, minigun, sniper, knife, bat and lightsaber damage other players.
- Grenade and air strike splash damage can also hurt the caller.
- Emotes sync so other players can see them.

Performance changes:
- High-performance WebGL preference.
- Render pixel ratio capped at 1.35.
- Shadows disabled and expensive world geometry/lights reduced.

Render hosting:
Keep server.js and game.html in the same repository. Render start command: node server.js
