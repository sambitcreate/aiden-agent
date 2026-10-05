#!/usr/bin/env python3
"""Generate marketing/rive/aiden/scene.rml — the Aiden character rig.

The art is a fixed template; animations, the state machine and the view model
are generated so every mood timeline keys the same property set (Rive keeps a
property's last applied value when a new state doesn't key it).

    python3 marketing/rive/tools/build_scene.py
"""
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "aiden" / "scene.rml"

# ---------------------------------------------------------------- ids
ROOT, SQUASH, LEAN, LOOKLEAN = "1:1", "1:2", "1:3", "1:4"
BODY = "1:10"
FACE, EYES_OPEN, SMILE, FACE_LOOK, FACE_MOOD, EYES_HAPPY = "1:20", "1:21", "1:25", "1:26", "1:27", "1:28"
ARM_R, ARM_R_WAVE, ARM_L = "1:30", "1:32", "1:40"
SHADOW, BACKDROP = "1:50", "1:60"
DOTS, DOT1, DOT2, DOT3 = "1:70", "1:71", "1:72", "1:73"
SPARKS = "1:80"
SPARK = ["1:81", "1:82", "1:83", "1:84"]
LOOK_TARGET, HIT_AREA, JOYSTICK = "1:90", "1:91", "1:95"

VM, VM_INST = "2:1", "2:20"
ENUM, E_IDLE, E_THINK, E_CELEB = "2:2", "2:3", "2:4", "2:5"
P_MOOD, P_WAVE, P_BG, P_HOVER = "2:10", "2:11", "2:12", "2:13"

A_IDLE, A_THINK, A_CELEB, A_WAVE, A_WAVE_REST = "4:1", "4:2", "4:3", "4:4", "4:5"
A_BLINK, A_LOOKX, A_LOOKY, A_BG_OFF, A_BG_ON = "4:6", "4:7", "4:8", "4:9", "4:10"

# property keys (rive schema <Type> --animatable)
X, Y, ROT, SX, SY, OP = 13, 14, 15, 16, 17, 18

EASE = {
    "inout": (0.42, 0, 0.58, 1),
    "out": (0.16, 1, 0.3, 1),
    "in": (0.55, 0, 0.9, 0.45),
    "soft": (0.37, 0, 0.63, 1),
}

# ---------------------------------------------------------------- helpers

def kf(frame, value, ease):
    if ease in ("hold", "linear"):
        return f'<KeyFrameDouble frame="{frame}" value="{value}" interpolationType="{ease}"/>'
    x1, y1, x2, y2 = EASE[ease]
    return (f'<KeyFrameDouble frame="{frame}" value="{value}" interpolationType="cubic">'
            f'<CubicEaseInterpolator x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}"/></KeyFrameDouble>')


def anim(aid, name, duration, tracks, loop="loop"):
    """tracks: {(objectId, propertyKey): [(frame, value, ease), ...] or constant}"""
    by_obj = {}
    for (obj, key), keys in tracks.items():
        if not isinstance(keys, list):
            keys = [(0, keys, "hold")]
        by_obj.setdefault(obj, []).append((key, keys))
    out = [f'<LinearAnimation loopValue="{loop}" fps="60" duration="{duration}" name="{name}" id="{aid}">']
    for obj, props in by_obj.items():
        out.append(f'  <KeyedObject objectId="{obj}">')
        for key, keys in props:
            out.append(f'    <KeyedProperty propertyKey="{key}">')
            for f, v, e in keys:
                out.append("      " + kf(f, v, e))
            out.append("    </KeyedProperty>")
        out.append("  </KeyedObject>")
    out.append("</LinearAnimation>")
    return "\n".join(out)


def loop3(a, b, n, ease="inout"):
    """a -> b -> a over n frames, seamless."""
    return [(0, a, ease), (n // 2, b, ease), (n, a, "hold")]


def enum_cond(value_id):
    return f'''<TransitionViewModelCondition>
  <TransitionPropertyViewModelComparator>
    <BindablePropertyEnum><DataBindContext sourcePathIds="{VM}-{P_MOOD}" propertyKey="637"/></BindablePropertyEnum>
  </TransitionPropertyViewModelComparator>
  <TransitionValueEnumComparator value="{value_id}"/>
</TransitionViewModelCondition>'''


def bool_cond(prop, value):
    return f'''<TransitionViewModelCondition>
  <TransitionPropertyViewModelComparator>
    <BindablePropertyBoolean><DataBindContext sourcePathIds="{VM}-{prop}" propertyKey="634"/></BindablePropertyBoolean>
  </TransitionPropertyViewModelComparator>
  <TransitionValueBooleanComparator value="{str(value).lower()}"/>
</TransitionViewModelCondition>'''


def trigger_cond(prop):
    return f'''<TransitionViewModelCondition>
  <TransitionPropertyViewModelComparator>
    <BindablePropertyTrigger><DataBindContext sourcePathIds="{VM}-{prop}" propertyKey="686"/></BindablePropertyTrigger>
  </TransitionPropertyViewModelComparator>
  <TransitionValueTriggerComparator/>
</TransitionViewModelCondition>'''


def write_bool(prop, value):
    return f'''<ListenerViewModelChange>
  <BindablePropertyBoolean propertyValue="{str(value).lower()}">
    <DataBindContext sourcePathIds="{VM}-{prop}" propertyKey="634" direction="true"/>
  </BindablePropertyBoolean>
</ListenerViewModelChange>'''


def blend(ms=300):
    x1, y1, x2, y2 = EASE["inout"]
    return f'duration="{ms}" interpolationType="cubic"', f'<CubicEaseInterpolator x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}"/>'


def transition(to, cond="", ms=300, extra=""):
    attrs, interp = blend(ms)
    return f'<StateTransition stateToId="{to}" {attrs} {extra}>{interp}{cond}</StateTransition>'


# ---------------------------------------------------------------- art

COL_INK = "FF3F3960"
COL_RIM = "EDE4FA"

ART = f'''
        <!-- Root: the character's base point. Float bob and hops move this. -->
        <Node x="540" y="860" name="Root" id="{ROOT}">
            <Node name="Squash" id="{SQUASH}">
                <Node rotation="0.10" name="Lean" id="{LEAN}">
                    <Node name="LookLean" id="{LOOKLEAN}">

                        <!-- Celebrate sparkles -->
                        <Node name="Sparkles" opacity="0" id="{SPARKS}">
                            <Shape x="-262" y="-560" scaleX="0" scaleY="0" name="Spark1" id="{SPARK[0]}">
                                <Star width="64" height="64" points="4" innerRadius="0.32" cornerRadius="3" name="Path"/>
                                <Fill name="Fill"><SolidColor colorValue="FFFFE7A3" name="C"/></Fill>
                            </Shape>
                            <Shape x="272" y="-470" scaleX="0" scaleY="0" name="Spark2" id="{SPARK[1]}">
                                <Star width="50" height="50" points="4" innerRadius="0.32" cornerRadius="3" name="Path"/>
                                <Fill name="Fill"><SolidColor colorValue="FFF3EAFF" name="C"/></Fill>
                            </Shape>
                            <Shape x="-222" y="-650" scaleX="0" scaleY="0" name="Spark3" id="{SPARK[2]}">
                                <Star width="40" height="40" points="4" innerRadius="0.32" cornerRadius="3" name="Path"/>
                                <Fill name="Fill"><SolidColor colorValue="FFF3EAFF" name="C"/></Fill>
                            </Shape>
                            <Shape x="226" y="-636" scaleX="0" scaleY="0" name="Spark4" id="{SPARK[3]}">
                                <Star width="58" height="58" points="4" innerRadius="0.32" cornerRadius="3" name="Path"/>
                                <Fill name="Fill"><SolidColor colorValue="FFFFE7A3" name="C"/></Fill>
                            </Shape>
                        </Node>

                        <!-- Thinking dots -->
                        <Node name="ThinkDots" id="{DOTS}">
                            <Shape x="292" y="-716" opacity="0" name="Dot3" id="{DOT3}">
                                <Ellipse width="46" height="46" name="Path"/>
                                <Fill name="Fill"><SolidColor colorValue="F2E8DDF7" name="C"/></Fill>
                            </Shape>
                            <Shape x="232" y="-650" opacity="0" name="Dot2" id="{DOT2}">
                                <Ellipse width="32" height="32" name="Path"/>
                                <Fill name="Fill"><SolidColor colorValue="F2E8DDF7" name="C"/></Fill>
                            </Shape>
                            <Shape x="190" y="-598" opacity="0" name="Dot1" id="{DOT1}">
                                <Ellipse width="22" height="22" name="Path"/>
                                <Fill name="Fill"><SolidColor colorValue="F2E8DDF7" name="C"/></Fill>
                            </Shape>
                        </Node>

                        <!-- Face: base position -> pointer look offset -> mood offset -->
                        <Node x="18" y="-372" name="Face" id="{FACE}">
                            <Node name="FaceLook" id="{FACE_LOOK}">
                                <Node name="FaceMood" id="{FACE_MOOD}">
                                    <Node opacity="0" name="EyesHappy" id="{EYES_HAPPY}">
                                        <Shape x="-62" y="4" name="HappyL">
                                            <PointsPath isClosed="false" name="Path">
                                                <StraightVertex x="-22" y="10"/>
                                                <CubicDetachedVertex x="0" y="-12" inRotation="3.1416" inDistance="13" outRotation="0" outDistance="13"/>
                                                <StraightVertex x="22" y="10"/>
                                            </PointsPath>
                                            <Stroke thickness="11" cap="round" join="round" name="Stroke"><SolidColor colorValue="{COL_INK}" name="C"/></Stroke>
                                        </Shape>
                                        <Shape x="78" y="4" name="HappyR">
                                            <PointsPath isClosed="false" name="Path">
                                                <StraightVertex x="-22" y="10"/>
                                                <CubicDetachedVertex x="0" y="-12" inRotation="3.1416" inDistance="13" outRotation="0" outDistance="13"/>
                                                <StraightVertex x="22" y="10"/>
                                            </PointsPath>
                                            <Stroke thickness="11" cap="round" join="round" name="Stroke"><SolidColor colorValue="{COL_INK}" name="C"/></Stroke>
                                        </Shape>
                                    </Node>
                                    <Node name="EyesOpen" id="{EYES_OPEN}">
                                        <Shape x="-62" y="0" name="EyeL">
                                            <Ellipse width="44" height="58" name="Path"/>
                                            <Fill name="Fill"><SolidColor colorValue="{COL_INK}" name="C"/></Fill>
                                        </Shape>
                                        <Shape x="78" y="0" name="EyeR">
                                            <Ellipse width="44" height="58" name="Path"/>
                                            <Fill name="Fill"><SolidColor colorValue="{COL_INK}" name="C"/></Fill>
                                        </Shape>
                                    </Node>
                                    <Shape x="8" y="56" name="Smile" id="{SMILE}">
                                        <PointsPath isClosed="false" name="Path">
                                            <StraightVertex x="-32" y="0"/>
                                            <CubicDetachedVertex x="0" y="14" inRotation="3.1416" inDistance="18" outRotation="0" outDistance="18"/>
                                            <StraightVertex x="32" y="0"/>
                                        </PointsPath>
                                        <Stroke thickness="10" cap="round" join="round" name="Stroke"><SolidColor colorValue="{COL_INK}" name="C"/></Stroke>
                                    </Shape>
                                </Node>
                            </Node>
                        </Node>

                        <!-- Body -->
                        <Shape name="Body" id="{BODY}">
                            <PointsPath isClosed="true" name="Path">
                                <CubicMirroredVertex x="6" y="-578" rotation="0" distance="112"/>
                                <CubicMirroredVertex x="198" y="-300" rotation="1.62" distance="175"/>
                                <CubicMirroredVertex x="4" y="0" rotation="3.1416" distance="150"/>
                                <CubicMirroredVertex x="-194" y="-300" rotation="-1.52" distance="175"/>
                            </PointsPath>
                            <Fill name="Fill">
                                <LinearGradient startX="120" startY="-540" endX="-160" endY="-10" name="Shade">
                                    <GradientStop colorValue="FFDCC4F2" position="0"/>
                                    <GradientStop colorValue="FFD3B3EE" position="0.5"/>
                                    <GradientStop colorValue="FFB596E0" position="1"/>
                                </LinearGradient>
                            </Fill>
                            <Stroke thickness="7" cap="round" join="round" name="Rim">
                                <LinearGradient startX="150" startY="-540" endX="40" endY="-380" name="RimFade">
                                    <GradientStop colorValue="FF{COL_RIM}" position="0"/>
                                    <GradientStop colorValue="00{COL_RIM}" position="1"/>
                                </LinearGradient>
                            </Stroke>
                        </Shape>

                        <!-- Waving arm (behind the body). ArmR = mood pose, ArmRWave = wave offset. -->
                        <Node x="150" y="-300" rotation="0.55" name="ArmR" id="{ARM_R}">
                            <Node name="ArmRWave" id="{ARM_R_WAVE}">
                                <Shape name="ArmRShape">
                                    <PointsPath isClosed="true" name="Path">
                                        <CubicMirroredVertex x="62" y="30" rotation="-1.62" distance="70"/>
                                        <CubicMirroredVertex x="64" y="-162" rotation="-1.45" distance="26"/>
                                        <CubicMirroredVertex x="18" y="-210" rotation="3.1416" distance="28"/>
                                        <CubicMirroredVertex x="-28" y="-160" rotation="1.62" distance="26"/>
                                        <CubicMirroredVertex x="-58" y="30" rotation="1.50" distance="70"/>
                                        <CubicMirroredVertex x="0" y="70" rotation="0" distance="30"/>
                                    </PointsPath>
                                    <Fill name="Fill">
                                        <LinearGradient startX="30" startY="-210" endX="-30" endY="20" name="G">
                                            <GradientStop colorValue="FFDFCBF4" position="0"/>
                                            <GradientStop colorValue="FFC3A4E8" position="1"/>
                                        </LinearGradient>
                                    </Fill>
                                    <Stroke thickness="6" cap="round" name="Rim">
                                        <LinearGradient startX="40" startY="-210" endX="0" endY="-120" name="G">
                                            <GradientStop colorValue="FF{COL_RIM}" position="0"/>
                                            <GradientStop colorValue="00{COL_RIM}" position="1"/>
                                        </LinearGradient>
                                    </Stroke>
                                </Shape>
                            </Node>
                        </Node>

                        <!-- Back arm (behind the body, darker) -->
                        <Node x="-150" y="-250" rotation="-2.05" name="ArmL" id="{ARM_L}">
                            <Shape name="ArmLShape">
                                <PointsPath isClosed="true" name="Path">
                                    <CubicMirroredVertex x="54" y="30" rotation="-1.6" distance="60"/>
                                    <CubicMirroredVertex x="44" y="-150" rotation="-1.5" distance="21"/>
                                    <CubicMirroredVertex x="6" y="-188" rotation="3.1416" distance="22"/>
                                    <CubicMirroredVertex x="-32" y="-148" rotation="1.62" distance="21"/>
                                    <CubicMirroredVertex x="-52" y="30" rotation="1.55" distance="60"/>
                                    <CubicMirroredVertex x="0" y="70" rotation="0" distance="30"/>
                                </PointsPath>
                                <Fill name="Fill">
                                    <LinearGradient startX="0" startY="-200" endX="0" endY="20" name="G">
                                        <GradientStop colorValue="FFC6A7E8" position="0"/>
                                        <GradientStop colorValue="FFA88AD0" position="1"/>
                                    </LinearGradient>
                                </Fill>
                            </Shape>
                        </Node>
                    </Node>
                </Node>
            </Node>
        </Node>

        <!-- Ground shadow: outside Root so it stays on the floor while the body floats. -->
        <Shape x="540" y="890" name="Shadow" id="{SHADOW}">
            <Ellipse width="340" height="56" name="Path"/>
            <Fill name="Fill">
                <RadialGradient startX="0" startY="0" endX="170" endY="0" name="G">
                    <GradientStop colorValue="660A1240" position="0"/>
                    <GradientStop colorValue="000A1240" position="1"/>
                </RadialGradient>
            </Fill>
        </Shape>

        <!-- Pointer plumbing: an invisible full-artboard hit area moves LookTarget;
             the Joystick reads LookTarget and poses LookX / LookY. -->
        <Node x="540" y="540" name="LookTarget" id="{LOOK_TARGET}"/>
        <Shape x="540" y="540" name="HitArea" id="{HIT_AREA}">
            <Rectangle width="1080" height="1080" name="Path"/>
            <Fill name="Fill"><SolidColor colorValue="00000000" name="C"/></Fill>
        </Shape>
        <Joystick posX="540" posY="540" width="1080" height="1080" xId="{A_LOOKX}" yId="{A_LOOKY}" handleSourceId="{LOOK_TARGET}" name="Look" id="{JOYSTICK}"/>

        <!-- Optional backdrop, toggled by showBackground -->
        <Node name="Backdrop" id="{BACKDROP}">
            <Shape x="540" y="520" name="Glow">
                <Ellipse width="980" height="980" name="Path"/>
                <Fill name="Fill">
                    <RadialGradient startX="0" startY="0" endX="490" endY="0" name="G">
                        <GradientStop colorValue="553D6BE0" position="0"/>
                        <GradientStop colorValue="003D6BE0" position="1"/>
                    </RadialGradient>
                </Fill>
            </Shape>
            <Shape x="540" y="540" name="Gradient">
                <Rectangle width="1080" height="1080" name="Path"/>
                <Fill name="Fill">
                    <LinearGradient startX="540" startY="-540" endX="-540" endY="540" name="G">
                        <GradientStop colorValue="FF003C8A" position="0"/>
                        <GradientStop colorValue="FF0B2768" position="0.55"/>
                        <GradientStop colorValue="FF101B53" position="1"/>
                    </LinearGradient>
                </Fill>
            </Shape>
        </Node>
'''

# ---------------------------------------------------------------- animations

def mood_base():
    """Neutral value for every property any mood keys."""
    t = {
        (ROOT, Y): 860, (SQUASH, SX): 1, (SQUASH, SY): 1, (LEAN, ROT): 0.10,
        (ARM_R, ROT): 0.55, (ARM_L, ROT): -2.05,
        (SHADOW, SX): 1, (SHADOW, OP): 1,
        (FACE_MOOD, X): 0, (FACE_MOOD, Y): 0,
        (EYES_OPEN, OP): 1, (EYES_HAPPY, OP): 0,
        (SMILE, SX): 1, (SMILE, SY): 1,
        (DOTS, Y): 0, (DOT1, OP): 0, (DOT2, OP): 0, (DOT3, OP): 0,
        (SPARKS, OP): 0,
    }
    for s in SPARK:
        t[(s, SX)] = 0
        t[(s, SY)] = 0
        t[(s, ROT)] = 0
    return t


def idle():
    n = 240
    t = mood_base()
    t.update({
        (ROOT, Y): loop3(860, 834, n),
        (SQUASH, SX): loop3(1, 0.985, n),
        (SQUASH, SY): loop3(1, 1.02, n),
        (LEAN, ROT): loop3(0.10, 0.045, n),
        (ARM_R, ROT): loop3(0.55, 0.68, n),
        (ARM_L, ROT): loop3(-2.05, -1.9, n),
        (SHADOW, SX): loop3(1, 0.84, n),
        (SHADOW, OP): loop3(1, 0.7, n),
    })
    return anim(A_IDLE, "idle", n, t)


def thinking():
    n = 240
    t = mood_base()
    tap = [(0, 2.0, "inout"), (60, 1.86, "inout"), (120, 2.0, "inout"), (180, 1.86, "inout"), (n, 2.0, "hold")]
    fade = lambda a, b: [(0, 0, "hold"), (a, 0, "out"), (a + 16, 1, "hold"), (b, 1, "inout"), (b + 22, 0, "hold"), (n, 0, "hold")]
    t.update({
        (ROOT, Y): loop3(860, 846, n),
        (LEAN, ROT): loop3(-0.03, -0.08, n),
        (ARM_R, ROT): tap,
        (ARM_L, ROT): loop3(-2.3, -2.2, n),
        (SHADOW, SX): loop3(1, 0.92, n),
        (SHADOW, OP): loop3(1, 0.85, n),
        (FACE_MOOD, X): [(0, 24, "inout"), (110, -8, "inout"), (n, 24, "hold")],
        (FACE_MOOD, Y): [(0, -18, "inout"), (110, -22, "inout"), (n, -18, "hold")],
        (SMILE, SX): 0.7,
        (SMILE, SY): 0.35,
        (DOTS, Y): loop3(0, -12, n),
        (DOT1, OP): fade(4, 186),
        (DOT2, OP): fade(26, 192),
        (DOT3, OP): fade(48, 198),
    })
    return anim(A_THINK, "thinking", n, t)


def celebrate():
    n = 96
    t = mood_base()

    def sq(pairs):
        return [(f, v, e) for f, v, e in pairs]

    t.update({
        (ROOT, Y): [(0, 860, "linear"), (10, 860, "out"), (36, 728, "inout"), (46, 724, "in"), (62, 860, "hold"), (n, 860, "hold")],
        (SQUASH, SX): sq([(0, 1, "inout"), (10, 1.12, "out"), (22, 0.9, "inout"), (40, 1, "inout"), (60, 0.98, "linear"), (63, 1.14, "out"), (78, 0.97, "inout"), (88, 1, "hold"), (n, 1, "hold")]),
        (SQUASH, SY): sq([(0, 1, "inout"), (10, 0.86, "out"), (22, 1.12, "inout"), (40, 1, "inout"), (60, 1.03, "linear"), (63, 0.85, "out"), (78, 1.04, "inout"), (88, 1, "hold"), (n, 1, "hold")]),
        (LEAN, ROT): [(0, 0.10, "inout"), (36, -0.05, "inout"), (62, 0.12, "inout"), (n, 0.10, "hold")],
        (ARM_R, ROT): [(0, 0.55, "inout"), (12, 0.95, "out"), (36, 0.78, "inout"), (50, 0.86, "inout"), (68, 0.62, "inout"), (n, 0.55, "hold")],
        (ARM_L, ROT): [(0, -2.05, "inout"), (12, -2.45, "out"), (36, -0.95, "inout"), (50, -1.15, "inout"), (68, -2.0, "inout"), (n, -2.05, "hold")],
        (SHADOW, SX): [(0, 1, "inout"), (10, 1.08, "out"), (36, 0.62, "inout"), (46, 0.6, "in"), (62, 1.1, "out"), (78, 1, "hold"), (n, 1, "hold")],
        (SHADOW, OP): [(0, 1, "inout"), (36, 0.45, "inout"), (46, 0.45, "in"), (62, 1, "hold"), (n, 1, "hold")],
        (FACE_MOOD, Y): [(0, 0, "inout"), (36, -8, "inout"), (62, 0, "hold"), (n, 0, "hold")],
        (EYES_OPEN, OP): 0,
        (EYES_HAPPY, OP): 1,
        (SMILE, SX): 1.3,
        (SMILE, SY): 1.6,
        (SPARKS, OP): 1,
    })
    for i, s in enumerate(SPARK):
        a = 28 + i * 5
        pop = [(0, 0, "hold"), (a, 0, "out"), (a + 12, 1.1, "inout"), (a + 30, 0, "hold"), (n, 0, "hold")]
        t[(s, SX)] = pop
        t[(s, SY)] = pop
        t[(s, ROT)] = [(0, 0, "linear"), (n, 1.5708, "hold")]
    return anim(A_CELEB, "celebrate", n, t)


def wave():
    keys = [(0, 0, "out"), (10, -0.28, "inout"), (22, 0.32, "inout"), (34, -0.28, "inout"),
            (46, 0.32, "inout"), (58, -0.22, "inout"), (72, 0, "hold"), (80, 0, "hold")]
    return anim(A_WAVE, "wave", 80, {(ARM_R_WAVE, ROT): keys}, loop="oneShot")


def wave_rest():
    return anim(A_WAVE_REST, "waveRest", 1, {(ARM_R_WAVE, ROT): 0}, loop="oneShot")


def blink():
    n = 300
    keys = [(0, 1, "hold"), (140, 1, "linear"), (145, 0.08, "linear"), (151, 1, "hold"),
            (258, 1, "linear"), (262, 0.08, "linear"), (267, 1, "linear"), (271, 0.08, "linear"), (276, 1, "hold"), (n, 1, "hold")]
    return anim(A_BLINK, "blink", n, {(EYES_OPEN, SY): keys})


def look_x():
    return anim(A_LOOKX, "lookX", 60, {
        (FACE_LOOK, X): [(0, -42, "linear"), (30, 0, "linear"), (60, 42, "hold")],
        (LOOKLEAN, ROT): [(0, -0.1, "linear"), (30, 0, "linear"), (60, 0.1, "hold")],
    }, loop="oneShot")


def look_y():
    # frame 0 = pointer at the top edge
    return anim(A_LOOKY, "lookY", 60, {
        (FACE_LOOK, Y): [(0, -34, "linear"), (30, 0, "linear"), (60, 22, "hold")],
    }, loop="oneShot")


def bg(aid, name, value):
    return anim(aid, name, 1, {(BACKDROP, OP): value}, loop="oneShot")


# ---------------------------------------------------------------- state machine

def state_machine():
    S_IDLE, S_THINK, S_CELEB = "3:11", "3:12", "3:13"
    S_REST, S_WAVE = "3:31", "3:32"
    S_BG_OFF, S_BG_ON = "3:51", "3:52"
    moods = {S_IDLE: (A_IDLE, E_IDLE), S_THINK: (A_THINK, E_THINK), S_CELEB: (A_CELEB, E_CELEB)}

    mood_states = []
    for i, (sid, (aid, _)) in enumerate(moods.items()):
        outs = "".join(transition(other, enum_cond(ev), 350) for other, (_, ev) in moods.items() if other != sid)
        mood_states.append(f'<AnimationState x="{160 + i * 220}" y="120" animationId="{aid}" id="{sid}">{outs}</AnimationState>')

    exit_100 = 'enableExitTime="true" exitTimeIsPercetange="true" exitTime="100"'
    return f'''
        <StateMachine name="Aiden" id="0:7">
            <StateMachineListenerSingle targetId="{HIT_AREA}" listenerTypeValue="move" name="Look at pointer">
                <ListenerAlignTarget targetId="{LOOK_TARGET}"/>
            </StateMachineListenerSingle>
            <StateMachineListenerSingle targetId="{BODY}" listenerTypeValue="enter" name="Hover in">
                {write_bool(P_HOVER, True)}
            </StateMachineListenerSingle>
            <StateMachineListenerSingle targetId="{BODY}" listenerTypeValue="exit" name="Hover out">
                {write_bool(P_HOVER, False)}
            </StateMachineListenerSingle>

            <StateMachineLayer name="Mood" id="3:10">
                <AnyState x="160" y="-120"/>
                <ExitState x="600" y="-120"/>
                <EntryState x="380" y="-120">
                    <StateTransition stateToId="{S_THINK}">{enum_cond(E_THINK)}</StateTransition>
                    <StateTransition stateToId="{S_CELEB}">{enum_cond(E_CELEB)}</StateTransition>
                    <StateTransition stateToId="{S_IDLE}"/>
                </EntryState>
                {"".join(mood_states)}
            </StateMachineLayer>

            <StateMachineLayer name="Wave" id="3:30">
                <AnyState x="160" y="-120"/>
                <ExitState x="600" y="-120"/>
                <EntryState x="380" y="-120"><StateTransition stateToId="{S_REST}"/></EntryState>
                <AnimationState x="160" y="120" animationId="{A_WAVE_REST}" id="{S_REST}">
                    {transition(S_WAVE, trigger_cond(P_WAVE), 120)}
                    {transition(S_WAVE, bool_cond(P_HOVER, True), 120)}
                </AnimationState>
                <AnimationState x="380" y="120" animationId="{A_WAVE}" reset="true" id="{S_WAVE}">
                    {transition(S_REST, "", 150, exit_100)}
                </AnimationState>
            </StateMachineLayer>

            <StateMachineLayer name="Blink" id="3:40">
                <AnyState x="160" y="-120"/>
                <ExitState x="600" y="-120"/>
                <EntryState x="380" y="-120"><StateTransition stateToId="3:41"/></EntryState>
                <AnimationState x="160" y="120" animationId="{A_BLINK}" id="3:41"/>
            </StateMachineLayer>

            <StateMachineLayer name="Background" id="3:50">
                <AnyState x="160" y="-120"/>
                <ExitState x="600" y="-120"/>
                <EntryState x="380" y="-120">
                    <StateTransition stateToId="{S_BG_ON}">{bool_cond(P_BG, True)}</StateTransition>
                    <StateTransition stateToId="{S_BG_OFF}"/>
                </EntryState>
                <AnimationState x="160" y="120" animationId="{A_BG_OFF}" id="{S_BG_OFF}">
                    {transition(S_BG_ON, bool_cond(P_BG, True), 400)}
                </AnimationState>
                <AnimationState x="380" y="120" animationId="{A_BG_ON}" id="{S_BG_ON}">
                    {transition(S_BG_OFF, bool_cond(P_BG, False), 400)}
                </AnimationState>
            </StateMachineLayer>
        </StateMachine>
'''


VIEW_MODEL = f'''
    <DataEnumCustom name="Mood" id="{ENUM}">
        <DataEnumValue key="idle" value="Idle" id="{E_IDLE}"/>
        <DataEnumValue key="thinking" value="Thinking" id="{E_THINK}"/>
        <DataEnumValue key="celebrate" value="Celebrate" id="{E_CELEB}"/>
    </DataEnumCustom>

    <ViewModel defaultInstanceId="{VM_INST}" name="Aiden" id="{VM}">
        <ViewModelPropertyEnumCustom enumId="{ENUM}" name="mood" id="{P_MOOD}"/>
        <ViewModelPropertyTrigger name="wave" id="{P_WAVE}"/>
        <ViewModelPropertyBoolean name="showBackground" id="{P_BG}"/>
        <ViewModelPropertyBoolean name="hover" id="{P_HOVER}"/>
        <ViewModelInstance exports="true" name="Default" id="{VM_INST}">
            <ViewModelInstanceEnum propertyValue="{E_IDLE}" viewModelPropertyId="{P_MOOD}"/>
            <ViewModelInstanceTrigger viewModelPropertyId="{P_WAVE}"/>
            <ViewModelInstanceBoolean propertyValue="false" viewModelPropertyId="{P_BG}"/>
            <ViewModelInstanceBoolean propertyValue="false" viewModelPropertyId="{P_HOVER}"/>
        </ViewModelInstance>
    </ViewModel>
'''


def build(out=OUT, matte=None):
    """matte: ARGB hex for an opaque full-artboard plate behind everything (render-only)."""
    anims = "\n".join([idle(), thinking(), celebrate(), wave(), wave_rest(), blink(),
                       look_x(), look_y(), bg(A_BG_OFF, "bgOff", 0), bg(A_BG_ON, "bgOn", 1)])
    plate = ""
    if matte:
        plate = f'''
        <Shape x="540" y="540" name="RenderMatte">
            <Rectangle width="1080" height="1080" name="Path"/>
            <Fill name="Fill"><SolidColor colorValue="{matte}" name="C"/></Fill>
        </Shape>'''
    doc = f'''<Rive version="1" kind="fragment">
    <!-- GENERATED by marketing/rive/tools/build_scene.py — edit that, not this. -->
    <Artboard defaultStateMachineId="0:7" styleId="0:5" viewModelId="{VM}" viewModelInstanceId="{VM_INST}" width="1080" height="1080" name="Aiden" id="0:2">
        <LayoutComponentStyle name="Artboard Style" id="0:5"/>
{ART}{plate}
{anims}
{state_machine()}
    </Artboard>
{VIEW_MODEL}
</Rive>
'''
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(doc)
    return out


if __name__ == "__main__":
    print(f"wrote {build()}")
