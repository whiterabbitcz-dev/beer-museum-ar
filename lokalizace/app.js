/* CBM spike: vizuální lokalizace nad stations.json + testbed (Martinův byt, Polycam).
   Matematika (engine prostor = y DOLŮ, jako pixely výkresu):
   - MindAR (A-Frame) drží kameru v počátku, anchor má matici T (marker -> kamera).
   - Kamera v soustavě markeru: p = T^-1 * origin; jednotka = šířka markeru -> size_mm dává metry.
   - Wall marker s normálou n (jednotková, kam se marker dívá): osa X obrázku (čtecí směr)
     tx = (n.y, -n.x); pozice = marker + (p.x * tx + p.z * n) * scale; výška = p.y.
   - Floor marker: "nahoru" na tisku = směrový vektor a; tx = (a.y, -a.x); výška = p.z.
   - Heading: forward kamery (0,0,-1) přes rotaci T^-1, průmět do (tx, n).
   - Testbed JSON je v DXF konvenci (y NAHORU, metry) -> při načtení flip y a normal.y.
   - Mezi fixy DR: heading gyro-delta od fixu (bez kompasu), krokoměr 0,7 m (bez dvojité integrace).
*/
(async function () {
  const $ = (id) => document.getElementById(id);
  const rad = (d) => d * Math.PI / 180, deg = (r) => r * 180 / Math.PI;

  // ---------- datasety ----------
  const museum = await fetch('spike-data.json').then(r => r.json());
  const testbedRaw = await fetch('stations-test.json').then(r => r.json());

  let MIRROR = JSON.parse(localStorage.getItem('spikeMirror') || 'true'); // true = flip y (DXF y-up -> engine y-down)
  function buildTestbed() {
    const f = MIRROR ? -1 : 1;
    const P = 100; // 1 m = 100 engine px
    const fp = (pt) => [pt[0] * P, f * pt[1] * P];
    const rooms = {};
    for (const [k, poly] of Object.entries(testbedRaw.rooms)) rooms[k] = poly.map(fp);
    const stations = testbedRaw.stations.map(s => ({
      id: s.id, order: s.order, name: s.name.cs, type: s.type,
      polygon: s.polygon.map(fp),
      centroid: (() => { const p = s.polygon.map(fp); return [p.reduce((a, q) => a + q[0], 0) / p.length, p.reduce((a, q) => a + q[1], 0) / p.length]; })(),
      placeholder: s.prokop_placeholder,
    }));
    const markers = [];
    testbedRaw.stations.forEach(s => (s.visual_markers || []).forEach(m => markers.push({
      id: m.id, station: s.id, surface: 'wall',
      x: m.x * P, y: f * m.y * P,
      normal: { x: m.normal[0], y: f * m.normal[1] },
      physical_size_mm: { width: m.size_mm, height: m.size_mm },
      image_ref: 'markers/' + m.image_ref,
    })));
    return { key: 'testbed', label: 'testbed byt', pxm: P, rooms, stations, markers, planImg: null };
  }
  function buildMuseum() {
    const stations = museum.stations.map(s => ({ id: s.id, order: s.order, name: s.name, type: 'exhibit', polygon: s.polygon, centroid: s.centroid }));
    const markers = museum.markers.map(mk => {
      const t = rad(mk.azimuth_deg);
      return { ...mk, normal: { x: Math.sin(t), y: -Math.cos(t) } };
    });
    return { key: 'museum', label: 'muzeum 2.NP', pxm: museum.meta.plan.scale_px_per_m, rooms: null, stations, markers, planImg: null };
  }
  let DS = { museum: buildMuseum(), testbed: buildTestbed() };
  let ds = DS.testbed; // default: testbed (Martin jde měřit byt)

  // kombinované pořadí targetů v targets-spike.mind (museum 0-3, testbed 4-9)
  const TARGETS = [
    ...museum.meta ? ['VM-S5-01', 'VM-S7-01', 'VM-FLOOR-01', 'VM-PROKOP-01'] : [],
    'T1-M', 'T2-M', 'T3-M', 'T4-M', 'T5-M', 'T6-M',
  ];
  function findMarker(id) {
    for (const d of Object.values(DS)) { const m = d.markers.find(x => x.id === id); if (m) return { m, d }; }
    return null;
  }

  // ---------- stav ----------
  const S = { mode: null, pos: null, heading: 0, lastFixAt: 0, gyroOffset: null, lastAlpha: null,
              targetIdx: 0, log: [], drSteps: 0, lastStepAt: 0, activeMarker: null, inStation: null };

  // ---------- jádro: póza z matice ----------
  function poseFromAnchorMatrix(mat4, mk, d) {
    const inv = new THREE.Matrix4().copy(mat4).invert();
    const cam = new THREE.Vector3(0, 0, 0).applyMatrix4(inv);
    const fwd = new THREE.Vector3(0, 0, -1).transformDirection(inv);
    const widthM = ((mk.physical_size_mm && mk.physical_size_mm.width) || 300) / 1000;
    const n = mk.normal, tx = { x: n.y, y: -n.x };
    let dx, dy, camH, fx, fy;
    if (mk.surface === 'floor') {
      dx = cam.x * widthM * tx.x + cam.y * widthM * n.x;
      dy = cam.x * widthM * tx.y + cam.y * widthM * n.y;
      camH = cam.z * widthM;
      fx = fwd.x * tx.x + fwd.y * n.x; fy = fwd.x * tx.y + fwd.y * n.y;
    } else {
      dx = cam.x * widthM * tx.x + cam.z * widthM * n.x;
      dy = cam.x * widthM * tx.y + cam.z * widthM * n.y;
      camH = cam.y * widthM;
      fx = fwd.x * tx.x + fwd.z * n.x; fy = fwd.x * tx.y + fwd.z * n.y;
    }
    return { pos: { x: mk.x + dx * d.pxm, y: mk.y + dy * d.pxm },
             heading: (deg(Math.atan2(fx, -fy)) + 360) % 360,
             dist: Math.hypot(dx, dy), camH };
  }

  function applyFix(pose, mk, d) {
    if (ds !== d) { ds = d; S.pos = null; $('roomLabel').textContent = ds.label; loadPlan(); }
    S.pos = S.pos ? { x: S.pos.x * 0.3 + pose.pos.x * 0.7, y: S.pos.y * 0.3 + pose.pos.y * 0.7 } : pose.pos;
    S.heading = pose.heading;
    S.lastFixAt = performance.now();
    S.activeMarker = { id: mk.id, dist: pose.dist, camH: pose.camH };
    if (S.lastAlpha != null) S.gyroOffset = S.heading + S.lastAlpha;
    setBadge('fix ' + mk.id, 'fresh');
    checkStation();
  }

  // ---------- příchod do stanice ----------
  function pointInPoly(p, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if ((yi > p.y) !== (yj > p.y) && p.x < (xj - xi) * (p.y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function checkStation() {
    if (!S.pos) return;
    const here = ds.stations.find(st => pointInPoly(S.pos, st.polygon));
    if (here && here.id !== S.inStation) {
      S.inStation = here.id;
      if (here.placeholder) showToast(here.placeholder, 6000);
      const idx = ds.stations.findIndex(st => st.id === here.id);
      if (idx === S.targetIdx && idx < ds.stations.length - 1) S.targetIdx = idx + 1; // auto další dle order/edges
    } else if (!here) S.inStation = null;
  }

  // ---------- senzory ----------
  function initSensors() {
    window.addEventListener('deviceorientation', (e) => {
      if (e.alpha == null) return;
      S.lastAlpha = e.alpha;
      if (S.gyroOffset != null && performance.now() - S.lastFixAt > 400)
        S.heading = ((S.gyroOffset - e.alpha) % 360 + 360) % 360;
    });
    window.addEventListener('devicemotion', (e) => {
      const a = e.accelerationIncludingGravity;
      if (!a || a.x == null) return;
      const mag = Math.abs(Math.hypot(a.x, a.y, a.z) - 9.81);
      const now = performance.now();
      if (mag > 1.2 && now - S.lastStepAt > 380 && S.pos && now - S.lastFixAt > 800) {
        S.lastStepAt = now; S.drSteps++;
        S.pos.x += Math.sin(rad(S.heading)) * 0.7 * ds.pxm;
        S.pos.y += -Math.cos(rad(S.heading)) * 0.7 * ds.pxm;
        setBadge('DR +' + S.drSteps + ' kroků', 'dr');
        checkStation();
      }
    });
  }
  async function askMotionPermission() {
    try {
      if (DeviceOrientationEvent.requestPermission) await DeviceOrientationEvent.requestPermission();
      if (DeviceMotionEvent.requestPermission) await DeviceMotionEvent.requestPermission();
    } catch (e) {}
  }

  // ---------- AR ----------
  async function loadTargets() {
    const r = await fetch('targets-spike.mind');
    if (!r.ok) throw new Error('targets-spike.mind nenalezen (HTTP ' + r.status + '). Soubor musí být ve větvi — kompilace se v demu neprovádí.');
    const ct = r.headers.get('content-type') || '';
    if (ct.indexOf('html') >= 0) throw new Error('targets-spike.mind vrací HTML místo dat (špatná cesta/hosting).');
    const buf = await r.arrayBuffer();
    if (buf.byteLength < 10000) throw new Error('targets-spike.mind je podezřele malý (' + buf.byteLength + ' B).');
    return buf;
  }

  function startAR(mindBuffer) {
    return new Promise((resolve, reject) => {
    const blobUrl = URL.createObjectURL(new Blob([mindBuffer]));
    const scene = document.createElement('a-scene');
    scene.setAttribute('mindar-image', `imageTargetSrc: ${blobUrl}; autoStart: true; uiLoading: no; uiScanning: no; uiError: no; maxTrack: 1;`);
    scene.setAttribute('vr-mode-ui', 'enabled: false');
    scene.setAttribute('device-orientation-permission-ui', 'enabled: false');
    const cam = document.createElement('a-camera');
    cam.setAttribute('look-controls', 'enabled: false');
    scene.appendChild(cam);
    TARGETS.forEach((id, i) => {
      const ent = document.createElement('a-entity');
      ent.setAttribute('mindar-image-target', 'targetIndex: ' + i);
      scene.appendChild(ent);
      let visible = false;
      ent.addEventListener('targetFound', () => { visible = true; });
      ent.addEventListener('targetLost', () => { visible = false; setBadge('bez fixu (DR)', 'dr'); });
      setInterval(() => {
        if (!visible) return;
        const f = findMarker(id);
        applyFix(poseFromAnchorMatrix(ent.object3D.matrix, f.m, f.d), f.m, f.d);
      }, 250);
    });
    scene.addEventListener('renderstart', () => resolve());
    scene.addEventListener('arError', (ev) => {
      const detail = ev && ev.detail ? JSON.stringify(ev.detail) : 'AR chyba (kamera zamítnuta / nedostupná?)';
      showError('AR engine', detail);
      reject(new Error(detail));
    });
    document.body.appendChild(scene);
    });
  }

  // ---------- minimapa ----------
  const canvas = $('minimap'), ctx = canvas.getContext('2d');
  function drawMinimap() {
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#F7F1E3'; ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate(-rad(S.heading));
    const view = ds.key === 'museum' ? 14 : 9; // metrů napříč
    const k = w / (view * ds.pxm);
    const c0 = S.pos || { x: ds.stations[0].centroid[0], y: ds.stations[0].centroid[1] };
    ctx.scale(k, k); ctx.translate(-c0.x, -c0.y);
    if (ds.key === 'museum' && ds.planImg) {
      const s = 6222 / 1600; ctx.drawImage(ds.planImg, 0, 0, 1600 * s, 1413 * s);
    }
    if (ds.rooms) {
      ctx.strokeStyle = '#17371F'; ctx.lineWidth = 6; ctx.fillStyle = 'rgba(23,55,31,.05)';
      for (const poly of Object.values(ds.rooms)) {
        ctx.beginPath(); poly.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]));
        ctx.closePath(); ctx.fill(); ctx.stroke();
      }
    }
    const tgt = ds.stations[S.targetIdx];
    ds.stations.forEach(st => {
      const r = ds.key === 'museum' ? 60 : 28;
      ctx.beginPath(); ctx.arc(st.centroid[0], st.centroid[1], r, 0, 7);
      ctx.fillStyle = st === tgt ? '#F2B10E' : '#17371F'; ctx.fill();
      ctx.fillStyle = st === tgt ? '#17371F' : '#F2B10E';
      ctx.font = 'bold ' + (ds.key === 'museum' ? 80 : 34) + 'px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(st.id.replace('S', '').replace('T', 'T'), st.centroid[0], st.centroid[1] + 2);
    });
    if (S.pos && tgt) {
      ctx.strokeStyle = '#F2B10E'; ctx.lineWidth = ds.key === 'museum' ? 18 : 8;
      ctx.setLineDash(ds.key === 'museum' ? [40, 30] : [16, 12]);
      ctx.beginPath(); ctx.moveTo(S.pos.x, S.pos.y); ctx.lineTo(tgt.centroid[0], tgt.centroid[1]); ctx.stroke();
      ctx.setLineDash([]);
    }
    ds.markers.forEach(mk => {
      const r = ds.key === 'museum' ? 30 : 12;
      ctx.fillStyle = '#c0392b'; ctx.fillRect(mk.x - r, mk.y - r, 2 * r, 2 * r);
    });
    if (S.pos) {
      const r = ds.key === 'museum' ? 45 : 18;
      ctx.fillStyle = '#1a6fd4'; ctx.beginPath(); ctx.arc(S.pos.x, S.pos.y, r, 0, 7); ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = r / 4; ctx.stroke();
    }
    ctx.restore();
    ctx.fillStyle = 'rgba(26,111,212,.25)';
    ctx.beginPath(); ctx.moveTo(w / 2, h / 2); ctx.lineTo(w / 2 - 34, h / 2 - 70); ctx.lineTo(w / 2 + 34, h / 2 - 70); ctx.closePath(); ctx.fill();
  }

  // ---------- HUD ----------
  const dispY = (y) => (ds.key === 'testbed' && MIRROR ? -y : y); // testbed log/stats v DXF konvenci
  function updateHud() {
    const tgt = ds.stations[S.targetIdx];
    $('targetName').textContent = 'Cíl: ' + tgt.id + ' ' + tgt.name;
    if (S.pos) {
      const dx = tgt.centroid[0] - S.pos.x, dy = tgt.centroid[1] - S.pos.y;
      const distM = Math.hypot(dx, dy) / ds.pxm;
      const bearing = (deg(Math.atan2(dx, -dy)) + 360) % 360;
      const rel = ((bearing - S.heading) % 360 + 360) % 360;
      $('arrow').style.transform = `rotate(${rel}deg)`;
      $('arrowLabel').textContent = `${tgt.id} · ${distM.toFixed(1)} m`;
      $('arrowWrap').classList.add('visible');
    }
    const age = S.lastFixAt ? ((performance.now() - S.lastFixAt) / 1000) : null;
    const am = S.activeMarker;
    $('stats').textContent =
      `dataset: ${ds.label}\n` +
      `pozice: ${S.pos ? (S.pos.x / ds.pxm).toFixed(2) + '; ' + (dispY(S.pos.y) / ds.pxm).toFixed(2) + ' m' : '—'}\n` +
      `heading: ${S.heading.toFixed(0)}°  fix: ${age ? age.toFixed(1) + ' s' : '—'}\n` +
      (am ? `marker ${am.id}: ${am.dist.toFixed(2)} m, výška ${am.camH.toFixed(2)} m\n` : '') +
      `stanice: ${S.inStation || '—'}  DR: ${S.drSteps}`;
  }
  function setBadge(t, cls) { const b = $('fixBadge'); b.textContent = t; b.className = cls || ''; }
  function showError(stage, msg) {
    const e = $('errBanner');
    e.textContent = 'Chyba (' + stage + '):\n' + msg;
    e.classList.add('visible');
    $('compileStatus').textContent = 'Chyba: ' + stage + ' — detail nahoře.';
    $('btnAR').disabled = false;
  }
  function withTimeout(promise, ms, stage) {
    return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(stage + ' nedoběhl do ' + (ms / 1000) + ' s')), ms))]);
  }
  let toastTimer;
  function showToast(text, ms) {
    const t = $('placeToast'); t.textContent = text; t.classList.add('visible');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('visible'), ms || 4000);
  }

  // ---------- ovládání ----------
  $('btnMeasure').onclick = () => {
    $('log').classList.toggle('visible');
    if (S.pos) {
      const rec = { t: new Date().toISOString(), dataset: ds.key, marker: S.activeMarker && S.activeMarker.id,
        dist_m: S.activeMarker && +S.activeMarker.dist.toFixed(3),
        x_m: +(S.pos.x / ds.pxm).toFixed(3), y_m: +(dispY(S.pos.y) / ds.pxm).toFixed(3),
        heading: +S.heading.toFixed(1), drSteps: S.drSteps, station: S.inStation };
      S.log.push(rec);
      const div = document.createElement('div'); div.textContent = JSON.stringify(rec);
      $('logLines').appendChild(div);
      $('logExport').value = JSON.stringify(S.log, null, 1);
    }
  };
  $('btnNext').onclick = () => { S.targetIdx = (S.targetIdx + 1) % ds.stations.length; };
  $('btnRoom').onclick = () => {
    ds = ds.key === 'museum' ? DS.testbed : DS.museum;
    S.pos = null; S.inStation = null; S.targetIdx = 0;
    $('roomLabel').textContent = ds.label; loadPlan();
  };
  $('btnMirror').onclick = () => {
    MIRROR = !MIRROR; localStorage.setItem('spikeMirror', JSON.stringify(MIRROR));
    DS.testbed = buildTestbed();
    if (ds.key === 'testbed') { ds = DS.testbed; S.pos = null; }
    showToast('Zrcadlení mapy: ' + (MIRROR ? 'DXF y nahoru (default)' : 'bez flipu'));
  };

  // ---------- simulace ----------
  function simFix(id) {
    const f = findMarker(id);
    const wM = ((f.m.physical_size_mm && f.m.physical_size_mm.width) || 300) / 1000;
    const T = new THREE.Matrix4().makeRotationY(rad(10));
    T.setPosition(new THREE.Vector3(0.2 / wM, -0.1 / wM, -2.5 / wM));
    applyFix(poseFromAnchorMatrix(T, f.m, f.d), f.m, f.d);
  }
  document.querySelectorAll('#simPad .btn').forEach(b => b.onclick = () => {
    const a = b.dataset.sim;
    if (a === 'fix1') simFix(ds.key === 'museum' ? 'VM-S5-01' : 'T1-M');
    if (a === 'fix2') simFix(ds.key === 'museum' ? 'VM-S7-01' : 'T3-M');
    if (a === 'walk' && S.pos) {
      S.pos.x += Math.sin(rad(S.heading)) * 0.7 * ds.pxm;
      S.pos.y += -Math.cos(rad(S.heading)) * 0.7 * ds.pxm;
      S.drSteps++; checkStation();
    }
    if (a === 'rot') S.heading = (S.heading + 30) % 360;
  });

  // ---------- start ----------
  function loadPlan() {
    if (ds.key === 'museum' && !ds.planImg) {
      ds.planImg = new Image(); ds.planImg.src = 'plan-2np.webp';
    }
  }
  async function boot(mode) {
    S.mode = mode; loadPlan();
    $('start').classList.add('hidden');
    $('hud').classList.add('visible');
    $('roomLabel').textContent = ds.label;
    if (mode === 'sim') { $('simPad').classList.add('visible'); setBadge('simulace'); }
    setInterval(() => { drawMinimap(); updateHud(); }, 120);
  }
  $('btnAR').onclick = async () => {
    $('btnAR').disabled = true;
    $('errBanner').classList.remove('visible');
    try {
      if (!(window.MINDAR && window.AFRAME && AFRAME.components['mindar-image']))
        throw new Error('Knihovny se nenačetly (AFRAME/MINDAR). Zkontroluj vendor/ soubory.');
      $('compileStatus').textContent = 'Načítám markery...';
      const buf = await withTimeout(loadTargets(), 15000, 'načtení targets');
      await askMotionPermission();
      initSensors();
      await boot('ar');
      $('compileStatus').textContent = '';
      await withTimeout(startAR(buf), 30000, 'start kamery/AR');
    } catch (e) {
      showError('start', e.message);
    }
  };
  $('btnSim').onclick = () => boot('sim');
})();
