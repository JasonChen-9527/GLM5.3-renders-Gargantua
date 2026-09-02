/* ============================================================
 * GARGANTUA v2 · 卡冈图雅 — WebGL2 渲染引擎
 * 管线：
 *   场景(RK4 测地线体积步进) → 亮度提取
 *   → 5 级 mip 双滤波下采样 → 逐级加法上采样（Bloom）
 *   → ACES 合成（分级/暗角/色散/颗粒）
 * ------------------------------------------------------------
 * 调参钩子（浏览器控制台 / 自动化验证用）：
 *   window.__tune                    读取当前参数
 *   window.__set('exposure', 1.4)    修改参数
 *   window.__cam(yaw, pitch, dist)    设定相机
 * 可调项：exposure / bloom / boost / doppler / kappa
 * ============================================================ */
(() => {
  'use strict';

  /* ---------------- 国际化（中 / EN） ---------------- */
  const I18N = {
    zh: {
      title: 'GARGANTUA · 卡冈图雅 — 致敬《星际穿越》',
      desc: '用 WebGL 光线步进与史瓦西测地线，在浏览器中呈现受《星际穿越》启发的超大质量黑洞「卡冈图雅」。',
      canvas: '卡冈图雅黑洞实时渲染',
      noglTitle: '需要 WebGL2 支持',
      noglText: '你的浏览器无法运行此渲染。请使用最新版 Chrome、Edge 或 Firefox 打开。',
      sub: '卡冈图雅 · 超大质量黑洞',
      tag: '《星际穿越》· 实时光线追踪致敬',
      controls: '渲染控制',
      quality: '画质',
      params: '黑洞参数',
      mass: '质量 MASS',
      horizon: '视界半径 HORIZON',
      isco: '内缘 ISCO',
      edge: '盘外缘 DISK EDGE',
      range: '观测距离 RANGE',
      fps: '帧率 FPS',
      quote: '不要温和地走进那个良夜。',
      cite: '狄兰·托马斯 ·《星际穿越》',
      hintDrag: '拖拽 · 环视黑洞',
      hintWheel: '滚轮 · 接近 / 远离',
      pause: '暂停', resume: '继续',
      pauseAria: '暂停渲染', resumeAria: '继续渲染',
    },
    en: {
      title: 'GARGANTUA — A Tribute to Interstellar',
      desc: 'A supermassive black hole inspired by Interstellar, rendered in the browser with WebGL ray-marching and Schwarzschild geodesics.',
      canvas: 'Real-time render of the Gargantua black hole',
      noglTitle: 'WebGL2 Required',
      noglText: 'Your browser cannot run this render. Please open it with the latest Chrome, Edge or Firefox.',
      sub: 'Gargantua · Supermassive Black Hole',
      tag: 'A real-time ray-tracing tribute to Interstellar',
      controls: 'Render controls',
      quality: 'Quality',
      params: 'Black hole parameters',
      mass: 'MASS',
      horizon: 'HORIZON RADIUS',
      isco: 'ISCO',
      edge: 'DISK EDGE',
      range: 'RANGE',
      fps: 'FPS',
      quote: 'Do not go gentle into that good night.',
      cite: 'Dylan Thomas · Interstellar',
      hintDrag: 'Drag · Orbit the black hole',
      hintWheel: 'Wheel · Zoom in / out',
      pause: 'PAUSE', resume: 'RESUME',
      pauseAria: 'Pause rendering', resumeAria: 'Resume rendering',
    },
  };

  const LS_KEY = 'gargantua-lang';
  let lang = (() => {
    try {
      const s = localStorage.getItem(LS_KEY);
      if (s === 'zh' || s === 'en') return s;
    } catch (e) { /* 隐私模式下忽略 */ }
    return (navigator.language || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en';
  })();
  let paused = false; // 提前声明，供 applyLang 读取暂停按钮文案

  const L = () => I18N[lang];

  function applyLang() {
    const dict = I18N[lang];
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const v = dict[el.dataset.i18n];
      if (v != null) el.textContent = v;
    });
    document.querySelectorAll('[data-i18n-aria]').forEach(el => {
      const v = dict[el.dataset.i18nAria];
      if (v != null) el.setAttribute('aria-label', v);
    });
    document.querySelectorAll('[data-i18n-content]').forEach(el => {
      const v = dict[el.dataset.i18nContent];
      if (v != null) el.setAttribute('content', v);
    });
    const quote = document.querySelector('.hud-br p');
    if (quote) quote.setAttribute('lang', lang === 'zh' ? 'zh-CN' : 'en');
    const pb = document.getElementById('btn-pause');
    if (pb) {
      pb.textContent = paused ? dict.resume : dict.pause;
      pb.setAttribute('aria-label', paused ? dict.resumeAria : dict.pauseAria);
    }
  }

  document.getElementById('btn-lang').addEventListener('click', () => {
    lang = lang === 'zh' ? 'en' : 'zh';
    try { localStorage.setItem(LS_KEY, lang); } catch (e) { /* 忽略 */ }
    applyLang();
  });
  applyLang();

  const canvas = document.getElementById('gl');
  const gl = canvas.getContext('webgl2', {
    antialias: false,
    alpha: false,
    depth: false,
    powerPreference: 'high-performance',
  });

  if (!gl) {
    document.getElementById('nogl').style.display = 'flex';
    return;
  }

  const hasFloat = !!gl.getExtension('EXT_color_buffer_float');

  /* ---------------- 着色器工具 ---------------- */
  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error(gl.getShaderInfoLog(s), src);
      throw new Error('shader compile failed');
    }
    return s;
  }
  function program(vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.error(gl.getProgramInfoLog(p));
      throw new Error('program link failed');
    }
    return p;
  }
  const U = (p, name) => gl.getUniformLocation(p, name);

  const progScene   = program(VERT, SCENE_FRAG);
  const progBright  = program(VERT, BRIGHT_FRAG);
  const progDown    = program(VERT, DOWN_FRAG);
  const progUp      = program(VERT, UP_FRAG);
  const progComp    = program(VERT, COMPOSITE_FRAG);

  const loc = {
    scene: {
      res: U(progScene, 'uRes'), time: U(progScene, 'uTime'),
      camPos: U(progScene, 'uCamPos'), camMat: U(progScene, 'uCamMat'),
      fov: U(progScene, 'uFovScale'), aspect: U(progScene, 'uAspect'),
      steps: U(progScene, 'uSteps'), boost: U(progScene, 'uDiskBoost'),
      doppler: U(progScene, 'uDoppler'), kappa: U(progScene, 'uKappa'),
    },
    bright: { tex: U(progBright, 'uTex') },
    down:   { tex: U(progDown, 'uTex'), half: U(progDown, 'uHalfTexel') },
    up:     { tex: U(progUp, 'uTex'),   half: U(progUp, 'uHalfTexel') },
    comp: {
      scene: U(progComp, 'uScene'), bloom: U(progComp, 'uBloom'),
      res: U(progComp, 'uRes'), time: U(progComp, 'uTime'),
      aspect: U(progComp, 'uAspect'),
      exposure: U(progComp, 'uExposure'), strength: U(progComp, 'uBloomStrength'),
    },
  };

  /* ---------------- 全屏三角形 ---------------- */
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  /* ---------------- 渲染目标 ---------------- */
  function createTarget(w, h) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const ifmt = hasFloat ? gl.RGBA16F : gl.RGBA8;
    gl.texStorage2D(gl.TEXTURE_2D, 1, ifmt, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo, w, h };
  }
  function freeTarget(rt) {
    if (rt) { gl.deleteTexture(rt.tex); gl.deleteFramebuffer(rt.fbo); }
  }

  const MIP_N = 6;                     // bloom 级数
  let sceneRT = null, mips = [];

  /* ---------------- 画质与尺寸 ---------------- */
  const QUALITY = {
    low:  { steps: 280, scale: 0.50, label: 'LOW' },
    med:  { steps: 480, scale: 0.80, label: 'MED' },
    high: { steps: 700, scale: 1.25, label: 'HIGH' },   // >1 = SSAA 超采样
  };
  let quality = 'med';
  let autoScale = 1.0;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  function rebuildTargets() {
    const q = QUALITY[quality];
    const s = q.scale * autoScale;
    const W = Math.max(2, Math.round(canvas.width * s));
    const H = Math.max(2, Math.round(canvas.height * s));
    freeTarget(sceneRT);
    sceneRT = createTarget(W, H);
    mips.forEach(freeTarget);
    mips = [];
    let w = W, h = H;
    for (let i = 0; i < MIP_N; i++) {
      w = Math.max(2, w >> 1);
      h = Math.max(2, h >> 1);
      mips.push(createTarget(w, h));
    }
  }

  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 1.75);
    canvas.width = Math.round(innerWidth * dpr);
    canvas.height = Math.round(innerHeight * dpr);
    canvas.style.width = innerWidth + 'px';
    canvas.style.height = innerHeight + 'px';
    rebuildTargets();
  }

  /* ---------------- 调参钩子 ---------------- */
  const tune = {
    exposure: 1.40,   // 曝光
    bloom: 1.10,      // bloom 强度
    boost: 1.58,      // 盘辐射增益（微降以缓解俯视亮侧高光截断）
    doppler: 1.0,     // 多普勒强度（0=电影模式 1=物理模式）
    kappa: 2.2,       // 盘消光系数
  };
  window.__tune = tune;
  window.__set = (k, v) => {
    if (k in tune) { tune[k] = v; return tune; }
    console.warn('unknown key:', k);
  };

  /* ---------------- 相机 ---------------- */
  const cam = {
    yaw: -0.85, pitch: 0.07,
    dist: 23, targetDist: 23,
    tYaw: -0.85, tPitch: 0.07,
    fov: 55,
  };

  let dragging = false, lastX = 0, lastY = 0, lastInteract = -10;
  const isTouch = matchMedia('(pointer: coarse)').matches;

  function perfNow() { return performance.now() / 1000; }

  function onDown(e) {
    dragging = true;
    lastX = e.clientX; lastY = e.clientY;
    lastInteract = perfNow();
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 合成事件无活动指针 */ }
  }
  function onMove(e) {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    cam.tYaw -= dx * 0.0045;
    cam.tPitch = Math.min(0.55, Math.max(-0.48, cam.tPitch + dy * 0.0032));
    lastInteract = perfNow();
  }
  function onUp() { dragging = false; }
  function onWheel(e) {
    e.preventDefault();
    cam.targetDist = Math.min(46, Math.max(9, cam.targetDist * (1 + Math.sign(e.deltaY) * 0.09)));
    lastInteract = perfNow();
  }
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  // 自动化验证用：设定相机目标
  window.__cam = (yaw, pitch, dist) => {
    cam.tYaw = yaw; cam.tPitch = pitch;
    if (dist) cam.targetDist = dist;
  };

  /* ---------------- 时间与暂停 ---------------- */
  let simTime = 0, prevT = perfNow();
  const pauseBtn = document.getElementById('btn-pause');
  function setPaused(v) {
    paused = v;
    pauseBtn.textContent = paused ? L().resume : L().pause;
    pauseBtn.setAttribute('aria-label', paused ? L().resumeAria : L().pauseAria);
  }
  pauseBtn.addEventListener('click', () => setPaused(!paused));

  /* ---------------- 画质切换 ---------------- */
  function setQuality(q) {
    quality = q;
    document.querySelectorAll('.q-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.q === q));
    rebuildTargets();
  }
  document.querySelectorAll('.q-btn').forEach(btn => {
    btn.addEventListener('click', () => setQuality(btn.dataset.q));
  });

  /* ---------------- HUD 读数 ---------------- */
  const elDist = document.getElementById('ro-dist');
  const elFps = document.getElementById('ro-fps');
  const RS_KM = 2.95e8;   // 1e8 太阳质量 → rs ≈ 2.95×10⁸ km
  function updateHUD() {
    const au = cam.dist * RS_KM / 1.496e8;
    elDist.textContent = cam.dist.toFixed(1) + ' rs ≈ ' + au.toFixed(0) + ' AU';
  }

  /* ---------------- 渲染一帧 ---------------- */
  const camMat = new Float32Array(9);

  function render() {
    const W = sceneRT.w, H = sceneRT.h;

    /* --- pass 1: 场景 --- */
    gl.bindFramebuffer(gl.FRAMEBUFFER, sceneRT.fbo);
    gl.viewport(0, 0, W, H);
    gl.useProgram(progScene);

    const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
    const px = cam.dist * cp * cy, py = cam.dist * sp, pz = cam.dist * cp * sy;

    // 相机基：forward 指向原点
    const fx = -px / cam.dist, fy = -py / cam.dist, fz = -pz / cam.dist;
    // right = normalize(cross(fwd, worldUp)) = normalize(-fz, 0, fx)
    let rx = -fz, ry = 0, rz = fx;
    let rl = Math.hypot(rx, ry, rz) || 1;
    rx /= rl; rz /= rl;
    // up = cross(right, fwd)
    const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;

    camMat[0] = rx; camMat[1] = ry; camMat[2] = rz;
    camMat[3] = ux; camMat[4] = uy; camMat[5] = uz;
    camMat[6] = fx; camMat[7] = fy; camMat[8] = fz;

    const fovScale = Math.tan(cam.fov * Math.PI / 360);
    gl.uniform2f(loc.scene.res, W, H);
    gl.uniform1f(loc.scene.time, simTime);
    gl.uniform3f(loc.scene.camPos, px, py, pz);
    gl.uniformMatrix3fv(loc.scene.camMat, false, camMat);
    gl.uniform1f(loc.scene.fov, fovScale);
    gl.uniform1f(loc.scene.aspect, W / H);
    gl.uniform1i(loc.scene.steps, QUALITY[quality].steps);
    gl.uniform1f(loc.scene.boost, tune.boost);
    gl.uniform1f(loc.scene.doppler, tune.doppler);
    gl.uniform1f(loc.scene.kappa, tune.kappa);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    /* --- pass 2: 亮度提取 → mip0 --- */
    gl.bindFramebuffer(gl.FRAMEBUFFER, mips[0].fbo);
    gl.viewport(0, 0, mips[0].w, mips[0].h);
    gl.useProgram(progBright);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sceneRT.tex);
    gl.uniform1i(loc.bright.tex, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    /* --- pass 3: 逐级下采样 --- */
    gl.useProgram(progDown);
    gl.uniform1i(loc.down.tex, 0);
    for (let i = 1; i < MIP_N; i++) {
      const src = mips[i - 1], dst = mips[i];
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
      gl.viewport(0, 0, dst.w, dst.h);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform2f(loc.down.half, 0.5 / src.w, 0.5 / src.h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    /* --- pass 4: 逐级加法上采样（bloom 累加） --- */
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(progUp);
    gl.uniform1i(loc.up.tex, 0);
    for (let i = MIP_N - 2; i >= 0; i--) {
      const src = mips[i + 1], dst = mips[i];
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
      gl.viewport(0, 0, dst.w, dst.h);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform2f(loc.up.half, 0.5 / src.w, 0.5 / src.h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.disable(gl.BLEND);

    /* --- pass 5: 合成到屏幕 --- */
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(progComp);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sceneRT.tex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, mips[0].tex);
    gl.uniform1i(loc.comp.scene, 0);
    gl.uniform1i(loc.comp.bloom, 1);
    gl.uniform2f(loc.comp.res, canvas.width, canvas.height);
    gl.uniform1f(loc.comp.time, simTime);
    gl.uniform1f(loc.comp.aspect, canvas.width / canvas.height);
    gl.uniform1f(loc.comp.exposure, tune.exposure);
    gl.uniform1f(loc.comp.strength, tune.bloom);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /* ---------------- 自适应分辨率 + 自动升档 ---------------- */
  let frameTimes = [], fpsSmooth = 60, lastHudT = 0, frames = 0, bumped = false;
  function adapt(dt) {
    frames++;
    frameTimes.push(dt);
    if (frameTimes.length < 40) return;
    const avg = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
    frameTimes = [];
    fpsSmooth = 1 / avg;
    if (avg > 0.040 && autoScale > 0.45) { autoScale = Math.max(0.45, autoScale - 0.15); rebuildTargets(); }
    else if (avg < 0.018 && autoScale < 1.0) { autoScale = Math.min(1.0, autoScale + 0.1); rebuildTargets(); }
    // GPU 富余时自动升档到 HIGH（仅一次）
    if (!bumped && frames > 150 && fpsSmooth > 75 && quality === 'med' && !isTouch) {
      bumped = true;
      setQuality('high');
    }
  }

  /* ---------------- 主循环 ---------------- */
  const AUTO_ORBIT = reducedMotion || isTouch ? 0 : 0.012;   // idle 自动环绕速度
  const DISK_SPEED = reducedMotion ? 0.35 : 1.0;

  function loop() {
    const now = perfNow();
    let dt = Math.min(now - prevT, 0.1);
    prevT = now;

    if (!paused) simTime += dt * DISK_SPEED;

    // 相机惯性
    const k = 1 - Math.pow(0.0001, dt);
    cam.yaw += (cam.tYaw - cam.yaw) * k;
    cam.pitch += (cam.tPitch - cam.pitch) * k;
    cam.dist += (cam.targetDist - cam.dist) * (1 - Math.pow(0.001, dt));

    // 闲置自动环绕（缓慢）
    if (!dragging && AUTO_ORBIT && now - lastInteract > 4.0) {
      cam.tYaw += AUTO_ORBIT * dt;
    }

    if (!document.hidden) {
      render();
      adapt(dt);
    }

    if (now - lastHudT > 0.25) {
      lastHudT = now;
      updateHUD();
      elFps.textContent = Math.round(fpsSmooth);
    }
    requestAnimationFrame(loop);
  }

  addEventListener('resize', resize);
  resize();
  updateHUD();
  requestAnimationFrame(loop);
})();
