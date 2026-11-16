/**
 * The Shader style's runtime. A Shader SVG carries its field as GLSL in <metadata class="illos-field">;
 * mountShader draws that field on a canvas beneath the SVG in the bar look, taking its time from the SVG's clock
 * animation, so whatever plays, pauses, restarts or holds the SVG's CSS animations drives the field too. Erasable
 * TypeScript only: Node runs this file as is, and the site and the registry ship it as is.
 */

/** Helpers every field may use, and its one uniform, uT (seconds into the cycle). */
export const PRELUDE = `precision highp float;
uniform float uT;
const float TAU = 6.2831853;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float blob(vec2 p, vec2 c, float r, float k) { vec2 d = p - c; return k * exp(-dot(d, d) / (r * r)); }
float sm(float a, float b, float t) { return smoothstep(a, b, t); }
float ease(float u) { u = clamp(u, 0.0, 1.0); return u < 0.5 ? 4.0 * u * u * u : 1.0 - pow(-2.0 * u + 2.0, 3.0) / 2.0; }
float seg(vec2 p, vec2 a, vec2 b, float r, float k) { vec2 ab = b - a; float h = clamp(dot(p - a, ab) / dot(ab, ab), 0.0, 1.0); vec2 d = p - a - ab * h; return k * exp(-dot(d, d) / (r * r)); }
float noise(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y); }
`;

/**
 * One value per bar cell (columns every 7 px from x = 4, cells on a 9.4 period), with the cell's grain. The field pass
 * and the still's sampler both use it, so the still is the live field's first frame.
 */
export const CELL = `
float cellValue(float col, float cell) {
  return field(vec2(4.0 + col * 7.0, cell * 9.4 + 3.5), uT) * (0.7 + 0.3 * hash(vec2(col, cell)));
}`;

/** The field pass: one pixel per cell into a COLS x CELLS texture, the value packed into red (coarse) and green (fine). */
export const FIELD_MAIN = `
void main() {
  float v = clamp(cellValue(floor(gl_FragCoord.x), floor(gl_FragCoord.y)) / 4.0, 0.0, 0.99999);
  gl_FragColor = vec4(floor(v * 255.0) / 255.0, fract(v * 255.0), 0.0, 1.0);
}`;

/** The canvas in cells for a frame of w x h: columns every 7 from x = 4 to w - 2, cells of 9.4 down h (720 x 460: 103 x 49). */
export const gridFor = (w: number, h: number): [number, number] => [Math.floor((w - 6) / 7) + 1, Math.ceil(h / 9.4)];

/**
 * The bar pass: per pixel, read its cell's value from the field pass and draw the bar look (ink and width by density,
 * screen lines, grid, sparks). Cheap per pixel; the field itself is worked out once per cell, not once per pixel.
 * As it is, it paints the ground too. With CLEAR defined (mountShader) the ground is left clear, so the page, a
 * gradient or a section edge, shows through: the look is painted over black and over white, and how much the two
 * differ is how much ground shows at that pixel. A light ink means a dark ground, where the grid and the screen lines
 * read louder, so there they draw at two thirds (grid) and a third (screen).
 */
export const BARS = `precision highp float;
uniform vec2 uRes; uniform vec2 uGrid; uniform float uDpr; uniform vec3 uGround; uniform vec3 uInk; uniform sampler2D uField;
uniform vec3 uR1; uniform vec3 uR2; uniform vec3 uR3; uniform vec3 uR4; uniform vec3 uSpark;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
vec3 paint(vec3 uGround, vec2 px, float v, float col, float cx, float cell) {
  vec3 color = uGround;
  float dark = step(0.5, uInk.g);
  if (mod(px.x, 96.0) < 1.0 || mod(px.y, 96.0) < 1.0) color = mix(uGround, uInk, mix(0.09, 0.06, dark));
  float dx = abs(px.x - cx);
  color = mix(color, mix(uGround, uR4, mix(0.18, 0.06, dark)), 1.0 - smoothstep(0.3, 0.7, dx));
  float w = 0.0; vec3 c = uR4; float a = 1.0;
  if (v >= 0.72) { w = 3.6; c = uR1; } else if (v >= 0.48) { w = 2.7; c = uR2; } else if (v >= 0.27) { w = 1.8; c = uR3; } else if (v >= 0.1) { w = 1.1; c = uR4; a = 0.55; }
  float bar = step(mod(px.y, 9.4), 7.0) * (1.0 - smoothstep(w * 0.5 - 0.35, w * 0.5 + 0.35, dx)) * step(0.001, w);
  color = mix(color, c, bar * a);
  if (w > 3.5 && hash(vec2(col, cell * 1.3)) > 0.55 && abs(mod(px.y, 9.4) - 3.0) < 0.8 && dx < 0.7) color = uSpark;
  return color;
}
void main() {
  vec2 px = vec2(gl_FragCoord.x, uRes.y * uDpr - gl_FragCoord.y) / uDpr;
  float col = floor((px.x - 4.0) / 7.0 + 0.5);
  float cx = 4.0 + col * 7.0;
  float cell = floor(px.y / 9.4);
  vec4 e = texture2D(uField, (vec2(col, cell) + 0.5) / uGrid);
  float v = (e.r + e.g / 255.0) * 4.0;
  if (col < 0.0 || col > uGrid.x - 1.0) v = 0.0;
#ifdef CLEAR
  vec3 onBlack = paint(vec3(0.0), px, v, col, cx, cell);
  vec3 onWhite = paint(vec3(1.0), px, v, col, cx, cell);
  gl_FragColor = vec4(onBlack, clamp(1.0 - (onWhite.g - onBlack.g), 0.0, 1.0));
#else
  gl_FragColor = vec4(paint(uGround, px, v, col, cx, cell), 1.0);
#endif
}`;

/** The gzipped size of this file in KB, quoted by the numbers line. A test keeps it true. */
export const RUNTIME_KB = 6.4;

/** The field pass for a field: the prelude, T (the cycle in seconds, which a field may use), the field, one value per cell. */
export const fragmentFor = (field: string, cycle: number): string => `${PRELUDE}const float T = ${cycle.toFixed(3)};\n${field}\n${CELL}${FIELD_MAIN}`;

/** The cycle and the field a Shader SVG carries, or null for any other SVG. */
export function readField(svg: Element): { cycle: number; field: string } | null {
  const meta = svg.querySelector("metadata.illos-field");
  if (!meta) return null;
  const cycle = Number(meta.getAttribute("data-cycle"));
  const field = (meta.textContent ?? "").trim();
  return cycle > 0 && /float\s+field\s*\(/.test(field) ? { cycle, field } : null;
}

const hex = (value: string, fallback: number[]): number[] => {
  const h = value.trim().replace("#", "");
  const full = h.length === 3 ? h.replace(/./g, "$&$&") : h;
  return /^[0-9a-f]{6}$/i.test(full) ? [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255) : fallback;
};

/** The light ramp and spark, used when the page sets no --illos-ramp-*. */
const RAMP = ["#16645a", "#1daf9c", "#3fdec9", "#c2f5ee"].map((c) => hex(c, [0, 0, 0]));
const SPARK = hex("#0b463e", [0, 0, 0]);

let probe: CanvasRenderingContext2D | null | undefined;
const unread = new Set<string>();
/**
 * Any CSS colour a role is set to (hex, rgb(), oklch(), a named colour) as sRGB from 0 to 1, read through a 1 px canvas.
 * A value the browser cannot read gives the fallback, with one console warning per value, never a silent white.
 */
function colour(value: string, fallback: number[]): number[] {
  const v = value.trim();
  if (!v) return fallback;
  const quick = hex(v, []);
  if (quick.length) return quick;
  probe ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (probe) {
    probe.fillStyle = "#010203";
    probe.fillStyle = v; // a value the canvas cannot read leaves the marker
    if (probe.fillStyle !== "#010203") {
      probe.clearRect(0, 0, 1, 1);
      probe.fillRect(0, 0, 1, 1);
      const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
      return [r! / 255, g! / 255, b! / 255];
    }
  }
  if (!unread.has(v)) {
    unread.add(v);
    console.warn(`Illos: the colour "${v}" could not be read, so the default is used.`);
  }
  return fallback;
}

/**
 * Draws the field of the Shader SVG inside `host` on a canvas beneath it, with a clear ground so the page shows
 * through, and marks the host `illos-live` (CSS then hides the still). Draws a frame whenever the clock's time changed; while the clock is not running it checks every
 * 250 ms, and an `illos:draw` event on the host draws at once (the preview renderer sends it after a seek). Does
 * nothing, and leaves the still, under reduced motion, without a GPU for WebGL, or if the field does not compile. Returns cleanup.
 */
export const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|basic render/i;

/**
 * A WebGL context only when a GPU draws it, else null. Drawn in software, a field holds the page's main thread every
 * frame, so the still stays instead. The flag catches a blocklisted GPU; the renderer's name catches a software
 * renderer that some browsers still hand out as WebGL.
 */
export function hardwareGl(canvas: HTMLCanvasElement, attributes: WebGLContextAttributes = {}): WebGLRenderingContext | null {
  // Asked once per page: on a software renderer each ask waits on the busy GPU process, and fields mount again and again.
  if (software) return null;
  const gl = canvas.getContext("webgl", { ...attributes, failIfMajorPerformanceCaveat: true }) as WebGLRenderingContext | null;
  if (software === undefined) {
    const info = gl?.getExtension("WEBGL_debug_renderer_info");
    software = !gl || Boolean(info && SOFTWARE.test(String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL))));
  }
  if (!software) return gl;
  gl?.getExtension("WEBGL_lose_context")?.loseContext();
  return null;
}
let software: boolean | undefined;

export function mountShader(host: HTMLElement): () => void {
  const svg = host.querySelector("svg");
  const spec = svg ? readField(svg) : null;
  if (!svg || !spec) return () => {};
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return () => {};
  const canvas = document.createElement("canvas");
  const gl = hardwareGl(canvas, { antialias: false });
  if (!gl) return () => {};
  const shader = (type: number, src: string) => {
    const s = gl.createShader(type);
    if (!s) return null;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
  };
  const vs = shader(gl.VERTEX_SHADER, "attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}");
  const link = (fs: WebGLShader | null) => {
    const prog = gl.createProgram();
    if (!vs || !fs || !prog) return null;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, "p");
    gl.linkProgram(prog);
    return gl.getProgramParameter(prog, gl.LINK_STATUS) ? prog : null;
  };
  // The frame comes from the file's viewBox (a 640 x 720 portrait scene as well as the usual 720 x 460).
  const [vw, vh] = (svg.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).slice(2).map(Number);
  const [fw, fh] = vw! > 0 && vh! > 0 ? [vw!, vh!] : [720, 460];
  const [COLS, CELLS] = gridFor(fw, fh);
  const fieldProg = link(shader(gl.FRAGMENT_SHADER, fragmentFor(spec.field, spec.cycle)));
  const barsProg = link(shader(gl.FRAGMENT_SHADER, `#define CLEAR\n${BARS}`));
  if (!fieldProg || !barsProg) return () => {};
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  // The field pass draws into a small texture, one texel per cell; the bar pass reads it.
  const cells = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, cells);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, COLS, CELLS, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, cells, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const uT = gl.getUniformLocation(fieldProg, "uT");
  const uRes = gl.getUniformLocation(barsProg, "uRes");
  const uGrid = gl.getUniformLocation(barsProg, "uGrid");
  const uDpr = gl.getUniformLocation(barsProg, "uDpr");
  const uInk = gl.getUniformLocation(barsProg, "uInk");
  const uRamp = [1, 2, 3, 4].map((i) => gl.getUniformLocation(barsProg, `uR${i}`));
  const uSpark = gl.getUniformLocation(barsProg, "uSpark");
  const uField = gl.getUniformLocation(barsProg, "uField");

  canvas.className = "illos-field-canvas";
  svg.parentNode?.insertBefore(canvas, svg);
  host.classList.add("illos-live");
  const clock = svg.querySelector(".sh-clock");
  let last = -1;
  let size = "";
  let raf = 0;
  let timer = 0;
  let gone = false;

  // Layout and colours are read at most every half second: a read every frame would force style and layout each frame
  // while the labels animate. A resize or a theme switch shows within half a second.
  let measured = -Infinity;
  let w = 1;
  let h = 1;
  let ink = [0.165, 0.165, 0.165];
  let ramp = RAMP;
  let spark = SPARK;
  const measure = () => {
    const box = svg.getBoundingClientRect();
    // The canvas sits exactly where the drawing is: the SVG's viewBox fitted whole and centred in its box (the default
    // preserveAspectRatio), so the field and the lines over it stay together however the page sizes the SVG, even in a
    // box of another shape.
    const vb = svg.viewBox?.baseVal;
    const fit = vb && vb.width > 0 && vb.height > 0 ? Math.min(box.width / vb.width, box.height / vb.height) : 0;
    const dw = fit ? vb!.width * fit : box.width;
    const dh = fit ? vb!.height * fit : box.height;
    const hostBox = host.getBoundingClientRect();
    Object.assign(canvas.style, {
      left: `${box.left - hostBox.left - host.clientLeft + (box.width - dw) / 2}px`,
      top: `${box.top - hostBox.top - host.clientTop + (box.height - dh) / 2}px`,
      width: `${dw}px`,
      height: `${dh}px`,
    });
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    w = Math.max(1, Math.round(dw * dpr));
    h = Math.max(1, Math.round(dh * dpr));
    const style = getComputedStyle(svg);
    // The page's role first, then the SVG's own fallback, which follows the system theme like the still does.
    const role = (r: string) => style.getPropertyValue(`--illos-${r}`).trim() || style.getPropertyValue(`--_${r}`);
    ink = colour(role("ink"), [0.165, 0.165, 0.165]);
    ramp = RAMP.map((fallback, i) => colour(role(`ramp-${i + 1}`), fallback));
    spark = colour(role("spark"), SPARK);
    measured = Date.now();
  };
  const draw = () => {
    const anim = clock?.getAnimations?.()[0];
    const t = (((Number(anim?.currentTime) || 0) / 1000) % spec.cycle + spec.cycle) % spec.cycle;
    if (Date.now() - measured > 500) measure();
    const look = `${w}x${h} ${ink} ${ramp} ${spark}`; // a resize or a theme switch redraws even while the clock is held
    if (t !== last || look !== size) {
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      size = look;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.viewport(0, 0, COLS, CELLS);
      gl.useProgram(fieldProg);
      gl.uniform1f(uT, t);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.useProgram(barsProg);
      gl.uniform2f(uRes, fw, fh);
      gl.uniform2f(uGrid, COLS, CELLS);
      gl.uniform1f(uDpr, w / fw);
      gl.uniform3fv(uInk, ink);
      ramp.forEach((c, i) => gl.uniform3fv(uRamp[i]!, c));
      gl.uniform3fv(uSpark, spark);
      gl.bindTexture(gl.TEXTURE_2D, cells);
      gl.uniform1i(uField, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      last = t;
    }
    return anim?.playState === "running";
  };
  // After the clock stops (a cycle ended, or it paused), keep watching every frame for a while: a player restarts a
  // loop a frame later, and the field must follow at once. Then sleep, checking every 250 ms.
  let idle = 0;
  const tick = () => {
    raf = 0;
    timer = 0;
    if (gone) return;
    idle = draw() ? 0 : idle + 1;
    if (idle < 20) raf = requestAnimationFrame(tick);
    else timer = window.setTimeout(tick, 250);
  };
  const now = () => {
    if (!gone) draw();
  };
  const stop = () => {
    if (gone) return; // a late context loss after cleanup must not touch a host another mount now owns
    gone = true;
    cancelAnimationFrame(raf);
    clearTimeout(timer);
    host.removeEventListener("illos:draw", now);
    canvas.remove();
    host.classList.remove("illos-live");
    gl.getExtension("WEBGL_lose_context")?.loseContext(); // free the context now: browsers cap how many are live
  };
  canvas.addEventListener("webglcontextlost", stop);
  host.addEventListener("illos:draw", now);
  tick();
  return stop;
}
