# Procedural motion

How the editor makes a character walk from formulas (`src/core/motionGen/`), what goes in, how it is
checked, and which term to change, in which direction, for a given look. Nothing here plays a stored
clip: every pose is computed.

## 1. A path walked

The editor makes a walk from a path: where the character's capsule is over the floor at each time.
`locoPath(body, path, seconds)` (`locomotion.ts`) walks it, starting and stopping, round its bends, and
turning on the spot where it rests to set off another way. The parts it is made of:

- **The walk** (`gait.ts`): one stride at one speed, from the body's proportions. Its step, cadence,
  duty factor, knee course, swing and arm swing are laws of the speed (the Froude number), so one set of
  values serves any body size.
- **Carrying** (`carry.ts` `walkAlong`): the walk of each moment's pace is carried onto footfalls planned
  from the path. A planted foot does not move and rolls as the walk's foot does at that phase. A foot in
  the air is the walk's own swing, set down on its next place and bent along the way. The legs reach
  their feet by two-bone IK. A foot lands only when its leg can reach the place.
- **The turn on the spot** (`turn.ts`): three steps round the place the body turns about, a rule the same
  to both sides (a turn to the right is the turn to the left in a mirror; only the stance's own feet
  differ).
- **The chain** (`chain.ts`): the body's facing as it turns on the spot. The angle between where it will
  face and the line its feet have turned is shared out: the pelvis and the chest take their shares, the
  head a share of the rest, each within its reach. Each part follows by a critically damped spring of
  its own: the head first, the pelvis last.

### 1.1 A path whose pace changes

`locoPath(body, path, seconds)` (`locomotion.ts`) walks a whole path: where the capsule is at a time,
going at any pace between rest and the walk's top, round bends, stopping and setting off again. The
top pace is where the walk's stance share would fall to a half (faster, both feet leave the floor at
once and it is no longer a walk). The path is cut where it rests (for 1.4 s or more); each stretch
that moves is `walkAlong` (`carry.ts`), and a rest where the next stretch goes another way is a turn.

- **The pace.** A step is taken as the walk at the pace the body comes to within a step's time (one walk
  for each half cm/s): setting off or speeding up, a step is planned for the pace the body will have as it
  lands. Slow walking takes short steps at a cadence near an ordinary one, not long steps slowly. The
  phase goes by the distance gone, which keeps planted feet planted; but never so slowly that a foot in
  the air takes longer than the walk's own swing time to land, so a gentle set-off takes a shorter step
  instead of hanging over a long, slow one on one leg.
- **Setting off.** From standing, as the start rule has it (`START_STYLE`): the walk begins at the rule's phase against where the foot that stays
  stands (`phase`), and the foot on the side the body turns to steps first. Where the body is up to
  pace within that step, as in a quick start, its first step is a whole step of the walk it sets off
  into, not a slow walk's short step. That footfall lands a little wide and still turned part of the
  way toward where it stood (`landOut`, `landTurn`). The body turns at once, at a steady rate,
  settling at the end (`turn`). The foot that stays swivels with it (`swivel`); where the pelvis would be
  twisted against it further than it can be (`twistMost`), it pivots on its ball with the pelvis and
  bears the weight until the other foot is down, so long as that pivot is no more than the leg turns in
  the hip (`HUMAN_RANGES.hip.turn`); further round, it leaves at that twist and shuffles to its first
  footfall (`shuffle`). The trunk bows forward and the head with it, and turning, the body leans toward
  the foot that stays (`bow`, `shift`); the pose comes into the walk's in `blend` seconds if the pace
  is slower to, so that the body is down in the walk as its first foot lands. Up to 135° it turns as it sets off; further round it
  turns on the spot first (`turnFor`, `turnFrames`, its facing from the chain) and stands on for a
  moment while the pelvis, chest and head come round.
- **Stopping.** Braking, the phase goes by time (the feet keep stepping, the steps shorten) from just
  before the pace falls, bent the smoothest way so that the body stops as the last foot to land has
  just gone flat. That foot is the stance's own place about where the body stops, and does not move
  again; braking gently, the foot before it is set down no further on than its own place in the stance
  (the walk's lead would put it past it, and it would have to be stepped back), its step and its swing
  shortened to it. The foot behind bears part of the weight while the body brakes: it leaves once the
  body has stopped, lifts a little and is set down beside it (`STOP_STYLE.close`). Meanwhile the hips sway to the side,
  toward the foot that stands, as far as the stop rule has them (`STOP_STYLE.shift` of the way to the
  point of its sole the weight counts at). They take a stride of the walk they stopped from, the walk's
  own sway time; quicker, the floor would have to push from outside the sole that stands. The pelvis
  tucks and the chest comes forward over it as the stop rule has it (`STOP_STYLE.tuck`, from as the
  stop begins). If the foot behind would have to come further than `closeMost` (a stop straight after a
  sharp bend), the body takes one more, quicker and shorter step first.
- **Running legs.** Running, a leg in the air keeps the body's least knee bend
  (`HUMAN_MANNER.kneeLeast`): a trailing foot the leg cannot reach is drawn in, not snapped straight
  behind a body that vaults on. Walking, a leg straightens as it reaches for its footfall. (A plan's
  `airKnee` may be given by the kind of gait.)
- **Pushing and braking.** The body answers its pace changing as it feels it (`HUMAN_MANNER.react`).
  Running, the hips crouch into a push and the spine curls with it (`crouch`, `curl`); walking, it
  leans into its first step as a start does (above). Braking, the trunk tilts back (`tilt`); a walk's
  stop tucks as the stop rule has it.
- **Bends.** The hips lean into a bend by the sideways pull (`bank`) and the footfalls are set in from
  the walk's line (`track`), as in a turning walk, so the inner foot stays within its leg's reach.
- **Corners.** A body takes a corner over about a step: a path walked from a path file (`pathWalk.ts pathOnBody`)
  has every drawn corner rounded, each point the mean of the path over a leg's length to either side, weighted to fade
  toward the ends of that reach (worked out once every 5 mm along the path). Where the path is smooth on that scale, and
  at an open path's ends, the way is the path itself. A corner where the body comes to rest (between two timing keys at
  the same distance, `MotionPath.rests`) is not walked through: the reach shrinks to nothing there, so the body walks
  straight into its stop along the way it came and sets off along the way it goes, turning as it sets off.
- **A loop.** The body stands at first where the path begins, facing as `startHeading` has it (a path file: ahead,
  its z), and sets off turning to its way. With `endHeading` it turns on the spot to face that way after its last
  stop; a path file that is closed ends facing as it began, so its clip closes on itself.

The way's direction is taken over at least 5 mm of it. The path walk's own values are in `ALONG_STYLE`;
a walk's start and stop take the start and stop rules' numbers (`START_STYLE`, `STOP_STYLE`).

**Path files.** The path is drawn, not sampled: a path file (`<name>.path.json`, a data asset, read by
`core/motionPath.ts`) holds where the body goes and when, as two curves made the way an illustration
program makes them.

```json
{
  "format": "morglay-path", "version": 1, "closed": true,
  "points": [ { "at": [0, 0], "in": [0, -1.23], "out": [0, 1.61] }, ... ],
  "timing": { "keys": [ { "t": 0, "s": 0 }, { "t": 1, "s": 0, "out": [0.75, 0] }, ... ] }
}
```

- **Where.** Anchors with an in and an out handle, a cubic Bezier between each two (and from the last
  back to the first when closed). x is metres to the left and z metres ahead of where the body stands
  at first, facing ahead: the editor's x and z for a character facing +z. Handles are positions, as in
  SVG; one left out sits on its anchor (a corner).
- **When.** Keys of `s` (metres along the path) at `t` (seconds), a cubic in (t, s) between each two, as
  in an animation program's graph editor: a key's handles are offsets from it, `[dt, ds]`; without one
  the line to the next key is straight. Two keys at one `s` are a rest. `s` never goes back: a file
  whose handles would take it back, or make time run back, is refused.
- **Reading it.** `parsePath` checks the file, measures each segment (Gauss-Legendre over 64 pieces, well
  under a millimetre) and gives the place at a distance, the distance at a time (the time curve's own
  parameter solved for `t`) and `sample(t)`: [left, ahead] at a time, which `locoPath` walks.

`walkClip` (`pathWalk.ts`) makes the walk for a model: it measures the body from the skeleton (and the
sole from the mesh), walks the path on it with `locoPath` and puts the frames on the model's bones. A
closed path ends facing as it began (`endHeading` 0), so its clip closes on itself.

**Clips made as a model loads.** A model's animation lists clips made for it besides its file's own
(`AnimationDoc.sources`, `core/clipSources.ts`): a walk along a path asset, or a clip of a clip file (a
GLB of a skeleton and clips: dropped on a model it becomes an Animation asset) retargeted onto its
bones. The editor and Play load the model's GLB with those clips added, made in memory in a worker
(`engine/clips.ts`) once for every object showing that model with those sources; the model's file stays
as it is and nothing is stored. A built game ships the model's file and the sources' files and makes
the clips the same way. Inspector > Animation lists them, takes one out and adds a walk from a path
asset; the paths are drawn on the floor under their models in the editor. The Edelweiss Walk example
holds her VRM as it came and one path (`assets/a_edelweisspath1-walk.path.json`: a loop of 26.2 m in
34.4 s, three stops on the way): change the file and open the example again, and the walk is made
again for her body.

## 2. Checks

A motion is baked into a clip on the model's own bones and checked there:

- the ankles land where the formulas put them;
- a foot standing flat does not move between keys (0.2 mm);
- a standing leg reaches its ankle;
- no joint or sole goes under the floor;
- the ankles stay at least 8 cm apart;
- the hips' acceleration stays within limits;
- no bone turns more than 12° between keys at 60 fps;
- a loop closes on itself.

And what a body can do (`plausible.ts`): no joint past its range, the floor asked for no pull, for no push
with no foot standing and for no more along it than it grips, and the push asked from within the soles
that stand.

Each value is written as the cleanest number within 5 % of what it should be: one significant digit,
else one in halves (35, 0.15, 2.5), else two digits; where a rounding breaks a check, the next finer
number.

## 3. What to change for which look

Every number is one of three kinds (motionGen/manner.ts): the body's own (bones, soles, masses and joint ranges,
measured from the model and the human tables), physics (gravity and what follows from it for the
body), or the character's manner (ratios written once and named by every motion that uses them). The rules of starts,
stops and turns on the spot keep their own tables: they are what a viewer watches most. A
test counts the numbers written in the tables (`test/unit/parameters.test.ts`); a change may not add to them.

### Body, physics and manner (`manner.ts`)

| Look | Term | Change |
|---|---|---|
| Knees point more with the pelvis than with the feet | `HUMAN_MANNER.kneeFollow` 0.5 | raise |
| A working leg keeps its knee more bent (it never locks straight; this sets how far a leg reaches) | `HUMAN_MANNER.kneeLeast` 16° | raise |
| The neck turns more with the head | `HUMAN_MANNER.neck` 0.5 | raise |
| The body answers a change of pace later | `HUMAN_MANNER.react` 0.08 s | raise |
| Looks further ahead along its way | `HUMAN_MANNER.ahead` 0.2 strides | raise |
| Takes bends harder before it leans no further | `HUMAN_MANNER.turnMost` 0.3 g | raise |

### Arms

A run's arms are driven (the elbows held bent and snapped, the swing across the body) by effort: fully from
`GAIT_STYLE.armDrive` (a Froude number, 2.5) up and whenever the body speeds up or brakes to rest; slowing into a walk,
they are let go with the pace, the run's arm terms going over to the walk's (`gait.ts armsAt`).

| Look | Term | Change |
|---|---|---|
| A slowing run lets its arms go sooner | `GAIT_STYLE.armDrive` | raise |

### Facing as it turns on the spot (`CHAIN_STYLE`, chain.ts)

| Look | Term | Change |
|---|---|---|
| The pelvis follows the look more | `share[0]` 0.17 | raise |
| The chest follows the look more | `share[1]` 0.15 | raise |
| The body gets further round | `most` [pelvis 35°, chest 23°, head 55°] | raise |
| The head reacts faster to a new look | `time[2]` 0.18 s | lower |
| The body settles toward the look faster | `time[0]`, `time[1]` (0.8 s, 0.6 s) | lower |

### Bends (`BEND_STYLE`, carry.ts)

Each term is per unit of how sharply the way bends against the body's size (hip height over the bend's radius), so a
run's wider bend at the same turn per stride asks for less. The lean is per g of the sideways pull the body feels (its
speed times how fast its way turns), up to `HUMAN_MANNER.turnMost`.

| Look | Term | Change |
|---|---|---|
| Leans further into the turn | `bank` (share of hip height per sideways g) | raise |
| Feet set further in | `track` [inner, outer] | raise |

### Starts, stops, turns (`START_STYLE`, `STOP_STYLE`, `TURN_STYLE`)

| Look | Term | Change |
|---|---|---|
| Turns to the way sooner | `START_STYLE.turn` [length, from, to] | lower the times |
| The staying foot swivels more before it leaves | `START_STYLE.swivel` | raise |
| The stop's tuck begins sooner before it brakes | `STOP_STYLE.brakeAt` | raise |
| The closing step takes longer | `STOP_STYLE.close` (seconds) | raise |
| Pelvis tucks as it stops | `STOP_STYLE.tuck` | raise |
| Turn on the spot: when each of the three steps goes (either way round) | `TURN_STYLE.side.steps` | change |

### Path walks (`ALONG_STYLE`)

| Look | Term | Change |
|---|---|---|
| Slow walking takes shorter steps | `least` 0.3 m/s (the walk's shape is taken at no less than this pace) | lower |
| The pose is all the walk's from this pace on | `full` 1 m/s | lower |
| The feet keep their cadence longer while braking | `ahead` 0.4 s (the phase goes by time from so long before braking) | raise |
| One more step is taken sooner before a stop | `closeMost` 0.3 m | lower |
| The body stands up slower after a stop | `settleTime` 0.6 s | raise |
| Setting off and stopping from a walk: turning, the first footfall, the swivel, the sway onto the standing foot, the tuck | the start and stop rules' own terms (`START_STYLE`, `STOP_STYLE` above) | change there |
| Leans further into a bend, sets its feet further in | `BEND_STYLE.bank`, `.track` | raise |

## 4. Lessons

- **Carry what exists before writing new motion.** A start is the ordinary walk after its first steps,
  so it is the walk's pose by phase on planned footfalls.
- **Under acceleration, let the phase go by distance travelled.** Under braking, fix the footfall times
  and bend the phase to them.
- **Rules for a planted foot come on by amount, not by a gate.** An on/off condition popped a foot 16°
  in one frame.
- **What is found from samples must not jump as the gait changes.** The run's hips stood as high as the
  least headroom over 64 instants of its stride: as a run slowed into a walk its gait changed every frame,
  the least moved from instant to instant, and the hips shook by millimetres a frame (33 m/s²). The least
  is now found between its neighbours to a hair (`gait.ts leastOver`); likewise the longest step the legs
  can take is found by halving, not by cutting it 3 % at a time.
- **A curve that must stay between 0 and 1 is two least-jerk pieces.** The smoothest curve through an
  off-center top overshoots: a lift with its top at 76 % of a swing pushed the foot 20 cm down in
  mid-swing.
- **A half turn is either way round.** Decide which way by a rule (behind counts as left), or by the
  leading foot.
- **Braking is not walking slowly.** Letting the phase go by distance while braking froze the legs with
  the body, then crammed the last step and the closing step into what time was left: a hesitation and
  a slide. In the braking the phase goes by time, and the steps shorten instead.
- **Stop where the last foot is flat.** A body that stops right after a heel strikes stands up while the
  foot rolls flat: it looks like that foot slides. Stopping as it goes flat leaves it still; the other
  foot is then the only one that moves, and it lifts.
- **A step that would have to be dragged is a step to add.** After a sharp bend there is room for one
  step in the braking; the foot behind then has half a metre to come. One more, shorter step first.
- **Look for the minimum, not the end of the range.** Pitching a foot on its heel first brings the hip
  closer to the ankle, then further. A search that only looked at the end of each pivot's range missed
  the pitch that reaches, and put the toes straight up on a body with high ankles and a short heel.

## 5. Not yet

- The path is analyzed as a whole, offline. Re-planning every frame for a live controller (a streaming
  engine) comes next.
- A look that is separate from the path (looking one way, walking another), a guarded walk, a slope and
  a turn right about while walking are not made (a path file has none of them).
- The start's lean and the stop's tuck are still constants of their rules, not terms of acceleration.
- The turn on the spot has its own pose builder (`turn.ts`). It takes its facing from the chain but is
  not yet carried by `carry.ts`.
