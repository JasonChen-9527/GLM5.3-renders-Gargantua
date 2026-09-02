/* ============================================================
 * GARGANTUA v2 · 卡冈图雅 — 体积光线步进黑洞
 *
 * 物理核心：
 *  1. RK4 零测地线积分：a = -1.5 h²·p/r⁵
 *     （光子球 r=1.5rs 与临界冲击参数 b=2.598rs 精确复现）
 *  2. 体积化吸积盘：密度场积分 + 自吸收（辐射传输近似）
 *     垂直高斯剖面 + 径向包络 + 流线平流湍流 + 双臂密度波
 *  3. 开普勒差速旋转：噪声沿流体静止坐标采样（3D 时间维度
 *     连续再生湍流，从根本上消除周期呼吸伪影）
 *  4. 相对论效应：多普勒增亮 δ³ + 引力红移 √(1-1/r) +
 *     Shakura–Sunyaev 温度分布 T ∝ r^(-3/4)
 *  5. 程序化星空：三层星等幂律分布 + 银河带 + 尘埃暗隙
 *  6. 后期：5 级 mip 双滤波 Bloom（Jimenez 式）+ ACES +
 *     胶片分级（暖高光/冷阴影）+ 色散 + 颗粒
 * 全部图像程序化生成，无任何贴图。
 * ============================================================ */

const VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

/* ------------------------------------------------------------
 * 主场景：黑洞 + 体积吸积盘 + 星空
 * 单位约定：史瓦西半径 rs = 1.0
 * ---------------------------------------------------------- */
const SCENE_FRAG = `#version 300 es
precision highp float;

out vec4 fragColor;
in vec2 vUv;

uniform vec2  uRes;
uniform float uTime;
uniform vec3  uCamPos;
uniform mat3  uCamMat;     // 相机基（right, up, forward）
uniform float uFovScale;   // tan(fov/2)
uniform float uAspect;
uniform int   uSteps;
uniform float uDiskBoost;
uniform float uDoppler;     // 多普勒强度（0=电影模式，1=物理模式）
uniform float uKappa;       // 盘消光系数

const float PI      = 3.14159265;
const float DISK_IN  = 2.9;    // 内缘（ISCO 附近，物质于此停止绕行）
const float DISK_OUT = 15.0;   // 外缘
const float FAR_R    = 60.0;
const int   MAX_STEPS = 700;

/* ---------- 哈希 / 噪声 ---------- */
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}

float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i),               hash12(i + vec2(1, 0)), u.x),
             mix(hash12(i + vec2(0, 1)),  hash12(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.55;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++) {
    s += a * vnoise(p);
    p = m * p;
    a *= 0.5;
  }
  return s;
}

/* 3D 值噪声（第三维驱动湍流再生） */
float vnoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i);
  float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
             mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}

/* 八度间旋转矩阵（近似正交，打破轴对齐伪影） */
const mat3 OCT = mat3(0.80, 0.36, 0.48,
                     -0.36, 0.72, -0.60,
                     -0.48, 0.60, 0.64);
float fbm3(vec3 p) {
  float s = 0.0, a = 0.52;
  for (int i = 0; i < 4; i++) {
    s += a * vnoise3(p);
    p = OCT * p * 2.05;
    a *= 0.5;
  }
  return s * 1.03;
}

/* ---------- 黑体色温渐变（深红→橙→暖白→蓝白） ---------- */
vec3 blackbody(float t) {
  vec3 c = mix(vec3(0.34, 0.03, 0.0), vec3(1.05, 0.36, 0.07), smoothstep(0.0, 0.5, t));
  c = mix(c, vec3(1.05, 0.78, 0.47), smoothstep(0.50, 0.90, t));
  c = mix(c, vec3(1.06, 0.98, 0.93), smoothstep(0.90, 1.40, t));
  c = mix(c, vec3(0.82, 0.90, 1.18), smoothstep(1.40, 2.20, t));
  return c;
}

/* ---------- 测地线加速度（史瓦西零测地线近似） ---------- */
vec3 acc(vec3 p, float h2) {
  float r2 = dot(p, p);
  float r  = sqrt(r2);
  return -1.5 * h2 * p / (r2 * r2 * r);
}

/* ------------------------------------------------------------
 * 吸积盘密度场
 *  - 垂直：高斯剖面，内薄外厚（薄盘 flare）
 *  - 径向：ISCO 内缘截断 + 外缘渐隐
 *  - 湍流：沿开普勒流线平流的 3D fbm
 *  - 密度波：微弱双臂对数螺旋
 * ---------------------------------------------------------- */
float diskDensity(vec3 p, float r) {
  if (r > DISK_OUT + 1.0) return 0.0;
  float sig  = 0.16 + 0.032 * (r - DISK_IN);
  float vert = exp(-0.5 * p.y * p.y / (sig * sig));
  if (vert < 0.003) return 0.0;

  // 开普勒角速度 ω = 2.6·r^-1.5，回溯到流体静止坐标
  float w  = 2.6 * pow(r, -1.5) * uTime;
  float cw = cos(w), sw = sin(w);
  vec2 q = vec2(cw * p.x + sw * p.z, -sw * p.x + cw * p.z);

  // 环向丝缕：方位角低频 × 径向高频（trig 嵌入保证 φ 周期无接缝），
  // 差速剪切把湍流拉成沿旋转方向的长条——真实吸积盘的标志性结构
  float phi = atan(p.z, p.x);
  float pa  = phi - w;
  vec3 sp = vec3(cos(pa) * 0.9, sin(pa) * 0.9, log(r) * 6.5);
  float streak = fbm3(sp);

  // 团块湍流（3D 时间维连续再生）× 丝缕对比度调制
  float blob = fbm3(vec3(q * 0.42, uTime * 0.10));
  float n = pow(blob, 1.8) * 1.9 * (0.45 + 1.10 * streak);

  // 双臂 + 四臂密度波（随流体差速旋转的对数螺旋，强化大尺度流纹）
  float arm = 1.0 + 0.16 * sin(2.0 * (phi - w) + 2.4 * log(r))
                 + 0.12 * sin(4.0 * (phi - w) + 4.8 * log(r) + 1.7);

  // 外缘破碎：噪声调制截止半径，消除"程序化正圆"边界
  float edgeN = vnoise(q * 0.28);
  float rEff  = r + (edgeN - 0.5) * 1.6;

  float env = smoothstep(DISK_IN, DISK_IN + 0.35, r)
            * (1.0 - smoothstep(11.0, DISK_OUT, rEff));
  if (env <= 0.0) return 0.0;
  return vert * env * n * arm;
}

/* ------------------------------------------------------------
 * 吸积盘发射：Shakura–Sunyaev 温度 + 相对论频移
 *  β = 1/√(2(r-1))（史瓦西圆轨道速度，ISCO 处 0.5c）
 *  观测强度 I ∝ δ³（相对论聚束），色温 ∝ δ（多普勒+引力）
 * ---------------------------------------------------------- */
vec3 diskEmission(vec3 p, float r, vec3 vh, float dens) {
  float Temp = pow(DISK_IN / r, 0.75);          // T ∝ r^(-3/4)

  float beta = clamp(1.0 / sqrt(2.0 * max(r - 1.0, 0.5)), 0.0, 0.86);
  float gam  = inversesqrt(1.0 - beta * beta);
  vec3 tang  = vec3(-p.z, 0.0, p.x) / max(r, 1e-4);
  float dop  = 1.0 / (gam * (1.0 + beta * dot(tang, vh)));
  float grav = sqrt(max(1.0 - 1.0 / r, 0.0));
  float shift = mix(1.0, dop * grav, uDoppler);

  float br = pow(DISK_IN / r, 1.3);             // 径向辐射功率
  // δ⁴ 相对论聚束（观测辐射强度）+ 0.12 发射基底：
  // 基底保住远离侧的丝缕纹理可见度（纯 δ⁴ 会把暗侧细节压成平面）
  float beam = 0.12 + 0.88 * pow(shift, 4.0);
  return blackbody(Temp * shift) * (br * dens * beam) * uDiskBoost * 2.2;
}

/* ---------- 程序化星空（被引力透镜扭曲） ---------- */
vec3 starLayer(vec3 d, float sc, float thr, float gain) {
  vec3 p = d * sc;
  vec3 id = floor(p);
  vec3 f = fract(p) - 0.5;
  float h = hash13(id);
  if (h < thr) return vec3(0.0);
  vec3 off = (hash33(id + 7.7) - 0.5) * 0.7;
  float dd = length(f - off);
  float m = smoothstep(0.16, 0.02, dd);
  float mag = pow((h - thr) / (1.0 - thr), 3.0);
  vec3 tint = mix(vec3(1.0, 0.86, 0.72),
                  vec3(0.72, 0.82, 1.10),
                  hash13(id + 3.1));
  return tint * m * mag * gain;
}

vec3 background(vec3 d) {
  vec3 col = starLayer(d, 21.0, 0.950, 1.8);
  col += starLayer(d, 47.0, 0.928, 0.85);
  col += starLayer(d, 89.0, 0.908, 0.42);
  col += starLayer(d, 150.0, 0.895, 0.18);

  // 银河带（带内正交基坐标，无接缝）
  vec3 gn = normalize(vec3(0.35, 1.0, 0.20));
  vec3 e1 = normalize(cross(gn, vec3(1.0, 0.0, 0.0)));
  vec3 e2 = cross(gn, e1);
  vec2 gc = vec2(dot(d, e1), dot(d, e2)) * 2.6;
  float neb  = fbm(gc * 1.7 + 11.7);
  float dust = fbm(gc * 3.1 + 4.9);
  float band = pow(max(0.0, 1.0 - abs(dot(d, gn)) * 2.2), 2.8);
  // 尘埃暗隙：吸收带内的暗纹（银河最显著的视觉特征）
  float lane = 1.0 - 0.72 * smoothstep(0.32, 0.78, dust) * smoothstep(0.15, 0.70, band);
  col += band * lane * (0.030 + 0.16 * neb) * vec3(0.68, 0.76, 1.00);
  col += band * lane * pow(neb, 3.5) * 0.70 * vec3(1.00, 0.82, 0.62);

  // 极微弱的宇宙背景辉光
  col += vec3(0.012, 0.015, 0.024) * (0.4 + 0.6 * fbm(d.xy * 2.0 + 4.4));
  return col;
}

void main() {
  vec2 uv = (vUv * 2.0 - 1.0) * vec2(uAspect, 1.0);

  vec3 p = uCamPos;
  vec3 v = normalize(uCamMat * vec3(uv * uFovScale, 1.0));
  vec3 hv = cross(p, v);
  float h2 = dot(hv, hv);            // 守恒角动量²

  vec3 col = vec3(0.0);
  float trans = 1.0;                 // 透过率
  bool escaped = false;

  for (int i = 0; i < MAX_STEPS; i++) {
    if (i >= uSteps) break;
    float r2 = dot(p, p);

    if (r2 < 1.0) break;             // 事件视界捕获
    if (r2 > FAR_R * FAR_R && dot(p, v) > 0.0) { escaped = true; break; }

    float r  = sqrt(r2);
    float rc = length(p.xz);

    // 自适应步长：远处粗、光子球细
    float dt = clamp(0.06 * r, 0.025, 0.5);
    bool inSlab = abs(p.y) < 2.1 && rc > DISK_IN - 1.0 && rc < DISK_OUT + 1.0;
    if (inSlab) {
      float sig = 0.16 + 0.032 * (rc - DISK_IN);
      dt = min(dt, clamp(0.7 * sig, 0.06, 0.15));
    }

    /* ---- RK4 测地线积分 ---- */
    vec3 k1p = v;
    vec3 k1v = acc(p, h2);
    vec3 p2  = p + 0.5 * dt * k1p;
    vec3 k2p = v + 0.5 * dt * k1v;
    vec3 k2v = acc(p2, h2);
    vec3 p3  = p + 0.5 * dt * k2p;
    vec3 k3p = v + 0.5 * dt * k2v;
    vec3 k3v = acc(p3, h2);
    vec3 p4  = p + dt * k3p;
    vec3 k4p = v + dt * k3v;
    vec3 k4v = acc(p4, h2);

    vec3 pn = p + (dt / 6.0) * (k1p + 2.0 * k2p + 2.0 * k3p + k4p);
    vec3 vn = v + (dt / 6.0) * (k1v + 2.0 * k2v + 2.0 * k3v + k4v);

    /* ---- 体积吸积盘采样（辐射传输） ---- */
    if (inSlab) {
      float dens = diskDensity(p, rc);
      if (dens > 0.004) {
        vec3 vh = normalize(v);
        vec3 e = diskEmission(p, rc, vh, dens);
        col   += trans * e * dt;
        trans *= exp(-uKappa * dens * dt);
        if (trans < 0.01) break;     // 光学厚度饱和
      }
    }

    /* ---- 光子环发光 ----
     * 临界光线（h² ≈ (3√3/2)² = 6.75）在 r ≈ 1.5 光子球附近
     * 长距离绕行，路径积分自然汇聚成贴近视界的锐利亮环；
     * h² 加权确保落入视界的光线（h² 远小于临界值）不污染阴影内部。 */
    if (r < 2.7) {
      float pr = (r - 1.5) * (r - 1.5);
      float dh = (h2 - 6.75) * (h2 - 6.75);
      col += trans * blackbody(1.35) * (0.30 * dt)
           / ((1.0 + pr * 38.0) * (1.0 + dh * 2.5));
    }

    p = pn; v = vn;
  }

  // 逃逸光线采样星空（方向已被引力弯曲 → 星空扭曲）
  if (escaped) col += trans * background(normalize(v));

  fragColor = vec4(col, 1.0);
}`;

/* ------------------------------------------------------------
 * Bloom 预过滤：软阈值亮度提取
 * ---------------------------------------------------------- */
const BRIGHT_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uTex;
void main() {
  vec3 c = texture(uTex, vUv).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float k = smoothstep(0.42, 1.5, l);
  fragColor = vec4(c * k * k, 1.0);
}`;

/* ------------------------------------------------------------
 * 双滤波下采样（13-tap，Jimenez 2014 式）
 * ---------------------------------------------------------- */
const DOWN_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uTex;
uniform vec2 uHalfTexel;   // 0.5 × 源纹素
void main() {
  vec3 c = texture(uTex, vUv).rgb * 4.0;
  c += texture(uTex, vUv - uHalfTexel).rgb;
  c += texture(uTex, vUv + uHalfTexel).rgb;
  c += texture(uTex, vUv + vec2(uHalfTexel.x, -uHalfTexel.y)).rgb;
  c += texture(uTex, vUv - vec2(uHalfTexel.x, -uHalfTexel.y)).rgb;
  c += texture(uTex, vUv - vec2(uHalfTexel.x * 2.0, 0.0)).rgb;
  c += texture(uTex, vUv + vec2(uHalfTexel.x * 2.0, 0.0)).rgb;
  c += texture(uTex, vUv + vec2(0.0, uHalfTexel.y * 2.0)).rgb;
  c += texture(uTex, vUv - vec2(0.0, uHalfTexel.y * 2.0)).rgb;
  fragColor = vec4(c / 12.0, 1.0);
}`;

/* ------------------------------------------------------------
 * 双滤波上采样（5-tap tent，配合加法混合逐级累加）
 * ---------------------------------------------------------- */
const UP_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uTex;
uniform vec2 uHalfTexel;   // 0.5 × 粗级纹素
void main() {
  vec3 c = texture(uTex, vUv).rgb;
  c += texture(uTex, vUv + uHalfTexel).rgb;
  c += texture(uTex, vUv - uHalfTexel).rgb;
  c += texture(uTex, vUv + vec2(uHalfTexel.x, -uHalfTexel.y)).rgb;
  c += texture(uTex, vUv + vec2(-uHalfTexel.x, uHalfTexel.y)).rgb;
  fragColor = vec4(c / 5.0, 1.0);
}`;

/* ------------------------------------------------------------
 * 合成：Bloom + 曝光 + ACES + 胶片分级 + 暗角 + 色散 + 颗粒
 * ---------------------------------------------------------- */
const COMPOSITE_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform vec2  uRes;
uniform float uTime;
uniform float uAspect;
uniform float uExposure;
uniform float uBloomStrength;

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  // 边缘轻微色散（电影镜头感）
  vec2 c = (vUv - 0.5);
  vec2 off = c * dot(c, c) * 0.045;
  vec3 scene;
  scene.r = texture(uScene, vUv + off).r;
  scene.g = texture(uScene, vUv).g;
  scene.b = texture(uScene, vUv - off).b;

  vec3 bloom = texture(uBloom, vUv).rgb;
  vec3 col = scene + bloom * uBloomStrength;

  col *= uExposure;
  col = aces(col);

  // 胶片分级：暖高光 / 冷阴影 + 柔和 S 曲线
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(col, col * vec3(0.93, 1.00, 1.09), (1.0 - smoothstep(0.0, 0.55, lum)) * 0.16);
  col = mix(col, col * vec3(1.09, 1.00, 0.88), smoothstep(0.45, 1.0, lum) * 0.20);
  col = mix(col, col * col * (3.0 - 2.0 * col), 0.16);

  col = pow(col, vec3(1.0 / 2.2));

  // 暗角
  float vig = smoothstep(1.45, 0.35, length((vUv - 0.5) * vec2(uAspect, 1.0) * 1.1));
  col *= mix(0.68, 1.0, vig);

  // 胶片颗粒（兼作抖动，压制暗部色阶带）
  col += (hash12(vUv * uRes + fract(uTime) * 431.0) - 0.5) * 0.020;

  fragColor = vec4(col, 1.0);
}`;
