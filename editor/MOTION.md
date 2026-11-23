# Procedural motion

How the editor makes a character walk from formulas (`src/core/motionGen/`), what goes in, how its
constants were fitted to reference motions, and which term to change, in which direction, for a given
look. Nothing here plays a stored clip: every pose is computed. Reference motions are used only to fit
the constants, and only by comparing curves.

## 1. One formula, two inputs

`locomote(body, run)` (`locomotion.ts`) makes every walk. It takes:

- **The path:** where the character's capsule goes, as a point of the floor at any time. Speed, the turn
  of the way, its grade and its acceleration all come from it.
- **The look:** which way the character looks, as a direction at any time. Without one it looks along
  its path, `ahead` strides on.
- **The first state:** standing (facing some way), or walking (speed, phase of the walk, heading).
- **The posture:** ordinary or on guard. This is a setting of the character, not an input.

From these it picks the rule that carries the body:

| The inputs | Rule | Made by |
|---|---|---|
| A path that goes on | steady walk: straight, round a bend, up or down a slope, on guard in any direction | `locoLoop` |
| Standing, then a path that moves | start, turning to the way it goes | `walkStart` (`carry.ts`) |
| Walking, then a path that comes to rest | stop | `walkStop` |
| Walking, then a path that turns back | turn right about | `walkPivot` |
| Standing, a path that stays, a look elsewhere | turn on the spot, in three steps | `turnFor`, `turnFrames` (`turn.ts`) |
| Standing on guard | stepping on the spot | `stepGuard` (`guard.ts`) |

The parts it is made of:

- **The walk** (`gait.ts`): one stride at one speed, from the body's proportions. Its step, cadence,
  duty factor, knee course, swing and arm swing are laws of the speed (the Froude number), so one set of
  values serves any body size.
- **Carrying** (`carry.ts`): the walk is carried onto footfalls planned from the path. A planted foot does
  not move and rolls as the walk's foot does at that phase. A foot in the air is the walk's own swing,
  set down on its next place and bent along the way. The legs reach their feet by two-bone IK. A foot
  lands only when its leg can reach the place.
- **The chain** (`chain.ts`): the body's facing. The angle between the look and the line the legs walk
  on is shared out: the pelvis and the chest take their shares, the head a share of the rest, each
  within its reach. What none can reach is left short. The feet turn toward the look too, the one on the
  look's side more. When the look moves, each part follows by a critically damped spring of its own:
  the head first, the pelvis last.
- **The field** (`locomotion.ts`): the rest of the body (leaning into a turn, curling up a slope,
  crouching on guard, arm swing ...). Each is a sum of terms of the controls: turn per stride, grade and
  posture.
- **The rules' constants** (`LOCO_STYLE.rules`): the start's, stop's, turn right about's, turn on the
  spot's and guard step's own timings and placements.

All constants sit in one style object, `LOCO_STYLE`, so one fit reaches all of them.

### 1.1 A path whose pace changes

`locoPath(body, path, seconds)` (`locomotion.ts`) walks a whole path: where the capsule is at a time,
going at any pace between rest and the walk's top, round bends, stopping and setting off again. The
top pace is where the walk's stance share would fall to a half (faster, both feet leave the floor at
once and it is no longer a walk). The path is cut where it rests (for 1.4 s or more); each stretch
that moves is `walkAlong` (`carry.ts`), and a rest where the next stretch goes another way is a turn.

- **The pace.** The walk is taken at each time's pace (one walk for each half cm/s), so slow walking
  takes short steps at a cadence near an ordinary one, not long steps slowly. Its phase goes by the
  distance gone, which keeps planted feet planted.
- **Setting off.** From standing, the foot on the side the body turns to steps first, its first
  footfall landing still turned part of the way toward where it stood; the other foot swivels as the
  pelvis comes round; the body is round to its way in a second. Up to 135° it turns as it sets off;
  further round it turns on the spot first (`turnFor`, `turnFrames`, its facing from the chain) and
  stands on for a moment while the pelvis, chest and head come round.
- **Stopping.** Braking, the phase goes by time (the feet keep stepping, the steps shorten) from just
  before the pace falls, bent the smoothest way so that the body stops as the last foot to land has
  just gone flat. That foot is the stance's own place about where the body stops, and does not move
  again. The foot behind then leaves at its own time, lifts a little and is set down beside it. If it
  would have to come further than `closeMost` (a stop straight after a sharp bend), the body takes one
  more, quicker and shorter step first.
- **Bends.** The hips lean into a bend by the sideways pull (`bank`) and the footfalls are set in from
  the walk's line (`track`), as in a turning walk, so the inner foot stays within its leg's reach.
- **A loop.** With `endHeading` the body turns on the spot to face that way after its last stop; a
  path that ends where it began, facing as it began, gives a clip that closes on itself.

`walkOnModel` (`pathWalk.ts`) does it for a model: it measures the body from the skeleton (and the sole from the mesh), walks a `Trail` (where the capsule is, 240 times a second, as [left, ahead] metres) and writes the clip into a copy of the model's GLB. The editor calls it when the Edelweiss Walk example opens, so the project holds a trail and the model as it came, and no clip. The way's direction is taken over at least 5 mm of it: over less, the rounding of a trail's points turns the way about.

The values are in `ALONG_STYLE`. They are set by hand and checked (below), not fitted to reference
motions.

## 2. Fitting it to reference motions

1. **Give each reference its inputs.** Write down its path (for a clip that moves the character, the
   root's track; for one in place, its speed, turn rate and grade), its look, its first state and its
   posture. Align its first frame with a phase of the walk (a per-reference value, fitted with the
   rest). Feed these to `locomote`. Never feed it the reference's poses.
2. **Compare curves, not frames by eye.** Sample both at the same rate and take 44 curves:
   - the hips' place (left, fore, up);
   - the pelvis', the chest's and the head's facing, list and lean;
   - each foot's place, facing and pitch;
   - each knee's bend and facing;
   - each upper arm's out and fore angle, the elbow, and the forearm's fore angle.

   Unwrap curves that turn with the body by whole turns from the reference's first value. Align a motion
   that ends standing at its end, not its start.
3. **Score.** For each curve, take its rms difference divided by the reference curve's range (at least 2
   cm or 2°). The mean over the curves is the **distance**. The fit minimizes a weighted mean square:
   hips 2; pelvis, chest, head and feet 1; arms and elbows 0.5; knees and forearms 0.3.
4. **Fit by coordinate descent.** Take each named value in turn and try ± a step (first 20 % of its
   size). Keep the better one, or the lowest point of the parabola through the three. Shrink the step by
   2.5 when neither side is better. Score a value only on the references it shows in: a turning term on
   turning walks, a backward guard term on backward guard walks. Two or three rounds are enough.
5. **Read the values before keeping them.** A window that starts before 0 breaks the first pose. A
   share above 1 puts toes through the floor. A spring with a half-life of seconds means the part does
   not move. Pin such values and refit the rest. If the fit stalls, look at the curves for a movement
   the formula does not have yet, rather than adding knobs.
6. **Check on the model's own bones.** Bake the frames into a clip on the model, then check:
   - the ankles land where the formulas put them;
   - a foot standing flat does not move between keys (0.2 mm);
   - a standing leg reaches its ankle;
   - no joint or sole goes under the floor, or under the step it stands on;
   - the ankles stay at least 8 cm apart;
   - the hips' acceleration stays within limits;
   - no bone turns more than 12° between keys at 60 fps;
   - a loop closes on itself.

   Where the references themselves go further (a knee giving way on a lower step), take the limit from
   them.
7. **One formula over all.** Fit the shared values (the chain, the field) on all references at once. A
   kind of motion may lose at most 2 points of distance against being fitted on its own.
8. **Round.** Give each fitted value the cleanest number within 5 % of it: one significant digit, else
   one in halves (35, 0.15, 2.5), else two digits. Then check again; where a rounding breaks a check,
   take the next finer number for that value.

## 3. What to change for which look

### Facing (`LOCO_STYLE.chain`)

| Look | Term | Change |
|---|---|---|
| The pelvis follows the look more | `share[0]` 0.17 | raise |
| The chest follows the look more | `share[1]` 0.15 | raise |
| The head stops short of what it looks at | `reach` 1 | lower |
| The body gets further round when looking back | `most` [pelvis forward 35°, pelvis backing away 55°, chest 23°, head 55°] | raise |
| The feet open toward the look | `feet.forward` / `feet.backward` (near foot, other foot; looking left, looking right) | raise |
| Backs away sooner when looking back | `back` 110° | lower |
| The head reacts faster to a new look | `time[2]` 0.18 s | lower |
| The body settles toward the look faster | `time[0]`, `time[1]` (0.8 s, 0.6 s) | lower |
| Looks further ahead round a bend | `ahead` 0.2 strides | raise |

### Turning walk (`LOCO_STYLE.turning`, per radian the way turns in a stride)

| Look | Term | Change |
|---|---|---|
| Leans further into the turn | `bank` (share of hip height per sideways g) | raise |
| Feet set further in | `track` [inner, outer] | raise |
| Feet point into the turn | `toe` [inner, outer] | raise |
| Pelvis faces out of the turn | `face` (negative: out) | lower |
| Chest leads into the turn | `chest` | raise |
| Spine curls, the head with it | `curl` [degrees, the head's share] | raise |
| Chest and head roll into the turn | `roll` | raise |
| The outer arm swings wider | `armOut[1]`, `elbow` | raise |

### Slopes (`LOCO_STYLE.climbing.up` / `.down`, for the grade `climbing.grade`; a gentler slope takes as much less)

| Look | Term | Change |
|---|---|---|
| The body goes up to the next step sooner | `carry[0]` (steps after the foot lands; negative: before) | lower |
| ... over a longer time | `carry[1]` | raise |
| The toes catch the edge | `clear` [share of leg length, when] | raise the first |
| The leg in the air reaches down straight | `airKnee` | raise |
| Upright going up | `curl` | raise |
| Pelvis tucked going down | `bow` (negative) | lower |
| The head looks ahead, not down | `nod` | lower |
| A foot lands later on a step down | `late` (share of a stride) | raise |
| The feet go down the slope a little sideways | `toe` | change |

### On guard (`LOCO_STYLE.guard.forward` / `.backward`)

| Look | Term | Change |
|---|---|---|
| The stance turned further from what it faces | `offset` [pelvis, chest] | lower (more negative) |
| Turning to the right differs from turning to the left | `rightShare` | change |
| Lower, more crouched | `knee` [at the strike, through the stance], `sink` | raise |
| Wider stance | `wide` | raise |
| More bounce, or more surge backing away | `bob`, `surge` | raise the first number |
| The arms hang more and swing less | `armShare` | lower |
| A foot whips out as it leaves the floor | `swingTurn` [left, right, when] | raise |
| Cadence | `quick` | raise for quicker steps |

### Starts, stops, turns (`LOCO_STYLE.rules`)

| Look | Term | Change |
|---|---|---|
| Gets up to speed sooner | `start.accel` | lower |
| Turns to the way sooner | `start.turn` [length, from, to] | lower the times |
| The staying foot swivels more before it leaves | `start.swivel` | raise |
| Brakes later or longer | `stop.brakeAt`, `stop.brake` | change |
| The closing step | `stop.close` [wait, length] | change |
| Pelvis tucks as it stops | `stop.tuck` | raise |
| Turn right about keeps more of the old walk | `pivot.from`, `pivot.drop` | change |
| Turn on the spot: when each of the three steps goes | `turn.left.steps` / `turn.right.steps` | change |

### Path walks (`ALONG_STYLE`)

| Look | Term | Change |
|---|---|---|
| Slow walking takes shorter steps | `least` 0.3 m/s (the walk's shape is taken at no less than this pace) | lower |
| The pose is all the walk's from this pace on | `full` 1 m/s | lower |
| The feet keep their cadence longer while braking | `ahead` 0.4 s (the phase goes by time from so long before braking) | raise |
| The foot behind leaves later or steps longer | `close` [0.05, 0.5] s | change |
| One more step is taken sooner before a stop | `closeMost` 0.3 m | lower |
| The body stands up slower after a stop | `settleTime` 0.6 s | raise |
| Turning as it sets off: how long, how much the first foot lands turned, how much the other swivels | `turnTime` 1 s, `landTurn` 0.15, `swivel` 0.2 | change |
| Leans further into a bend, sets its feet further in | `bank` 0.35, `track` | raise |

## 4. Lessons

- **Carry what exists before writing new motion.** The start's curves are the ordinary walk after the
  first steps. So a start is the walk's pose by phase on planned footfalls. It matched before any
  fitting.
- **Under acceleration, let the phase go by distance travelled.** Under braking, fix the footfall times
  and bend the phase to them.
- **Rules for a planted foot come on by amount, not by a gate.** An on/off condition popped a foot 16°
  in one frame.
- **A curve that must stay between 0 and 1 is two least-jerk pieces.** The smoothest curve through an
  off-center top overshoots: a lift with its top at 76 % of a swing pushed the foot 20 cm down in
  mid-swing.
- **A foot lands when its leg reaches.** On the way down a slope the planned landing came before the leg
  could reach the lower step. The landing now waits.
- **Two inputs can be the same for two motions.** Walking away while looking back, and backing away while
  facing the same point, have the same path and look. The formula picks one; the other is a setting.
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
- **When a fit picks "never", read what it says.** The pelvis' and chest's springs went to many seconds
  on quick turns: they do not lead the legs there. A value no reference can show (how fast the body
  settles to a slowly moving look) is set for use, and its cost is written down.

## 5. Not yet

- The path is analyzed as a whole, offline. Re-planning every frame for a live controller (a streaming
  engine) comes next.
- Path walks (`ALONG_STYLE`) are set by hand and checked, not fitted to reference motions. A look that
  is separate from the path (looking one way, walking another) is not yet part of them.
- The start's lean and the stop's tuck are still constants of their rules, not terms of acceleration in
  the field.
- The turn on the spot has its own pose builder (`turn.ts`). It takes its facing from the chain but is
  not yet carried by `carry.ts`.
- One speed and one turn rate per kind were fitted. Other speeds, turn rates and grades follow the laws
  and the proportional terms, but no reference checked them.
