(() => {
    const viewport        = document.getElementById('viewport');
    const container       = document.getElementById('map-container');
    const creekContainer  = document.getElementById('creek-container');

    const MAP_W    = 3716;
    const MAP_H    = 2063;
    const MAX_SCALE = 3;
    const FRICTION  = 0.90;
    const ZOOM_LERP = 0.15;

    // ── Loading screen ────────────────────────────────────────────────────

    const loadingScreen = document.getElementById('loading-screen');
    const loadingBar    = document.getElementById('loading-bar');
    const mapImg        = container.querySelector('img');

    function dismissLoader() {
        loadingBar.classList.add('complete');
        setTimeout(() => {
            loadingScreen.classList.add('done');
            setTimeout(() => loadingScreen.remove(), 650);
        }, 280);
    }

    if (mapImg.complete && mapImg.naturalWidth > 0) {
        dismissLoader();
    } else {
        mapImg.addEventListener('load',  dismissLoader, { once: true });
        mapImg.addEventListener('error', dismissLoader, { once: true });
    }

    // ── Creek layers ──────────────────────────────────────────────────────────
    // To add a new creek: append an entry to CREEKS, add its <img class="creek-img">
    // and <div class="info-panel"> to index.html with matching ids.

    const CREEKS = [
        { id: 'creek-brothers', panelId: 'panel-brothers', src: 'media/brothers creek.png', zoomTo: 2.5, viewX: 0.30 },
    ];

    CREEKS.forEach(c => {
        c.img      = document.getElementById(c.id);
        c.panel    = document.getElementById(c.panelId);
        c.centroid = { x: MAP_W / 3, y: MAP_H / 2 };

        const hitCanvas  = document.createElement('canvas');
        hitCanvas.width  = MAP_W;
        hitCanvas.height = MAP_H;
        c.hitCtx = hitCanvas.getContext('2d', { willReadFrequently: true });

        const hitSrc = new Image();
        hitSrc.onload = () => {
            c.hitCtx.drawImage(hitSrc, 0, 0);
            c.centroid = calcCentroid(c.hitCtx);
            c.img.style.transformOrigin = `${c.centroid.x}px ${c.centroid.y}px`;

            // Build ripple and insert behind the creek image
            const ripple = document.createElement('div');
            ripple.className = 'creek-ripple';
            ripple.style.left = `${c.centroid.x}px`;
            ripple.style.top  = `${c.centroid.y}px`;
            for (let i = 0; i < 3; i++) {
                const ring = document.createElement('div');
                ring.className = 'creek-ripple-ring';
                ripple.appendChild(ring);
            }
            creekContainer.insertBefore(ripple, c.img);
            c.ripple = ripple;

            ripple.addEventListener('click', e => {
                e.stopPropagation(); // prevent viewport click from calling closePanel
                pullToCreek(c);
                openPanel(c);
            });
        };
        hitSrc.src = c.src;
    });

    function calcCentroid(hitCtx) {
        try {
            const d = hitCtx.getImageData(0, 0, MAP_W, MAP_H).data;
            let sx = 0, sy = 0, n = 0;
            for (let py = 0; py < MAP_H; py += 4)
                for (let px = 0; px < MAP_W; px += 4)
                    if (d[(py * MAP_W + px) * 4 + 3] > 10) { sx += px; sy += py; n++; }
            return n > 0 ? { x: sx / n, y: sy / n } : { x: MAP_W / 3, y: MAP_H / 2 };
        } catch { return { x: MAP_W / 3, y: MAP_H / 2 }; }
    }

    function isOverCreek(creek, viewX, viewY) {
        const mx = (viewX - x) / scale;
        const my = (viewY - y) / scale;
        // Sample a patch ~14 screen pixels wide so narrow creek lines are easy to hit
        const r  = Math.max(2, Math.round(14 / scale));
        const px = Math.max(0, (mx | 0) - r);
        const py = Math.max(0, (my | 0) - r);
        const pw = Math.min((mx | 0) + r + 1, MAP_W)  - px;
        const ph = Math.min((my | 0) + r + 1, MAP_H) - py;
        if (pw <= 0 || ph <= 0) return false;
        try {
            const d = creek.hitCtx.getImageData(px, py, pw, ph).data;
            for (let i = 3; i < d.length; i += 4) if (d[i] > 10) return true;
            return false;
        } catch { return false; }
    }

    function creekAt(viewX, viewY) {
        return CREEKS.find(c => isOverCreek(c, viewX, viewY)) ?? null;
    }

    // Wider screen-space hit area for touch (covers the ripple rings)
    function creekAtRipple(viewX, viewY) {
        return CREEKS.find(c => {
            const sx = c.centroid.x * scale + x;
            const sy = c.centroid.y * scale + y;
            return Math.hypot(viewX - sx, viewY - sy) < 80;
        }) ?? null;
    }

    // Hover
    let hoveredCreek = null;

    // Panel
    let openCreek = null;
    const titleEl   = document.getElementById('title');
    const mapDimmer = document.getElementById('map-dimmer');

    function openPanel(creek) {
        closePanel();
        if (hoveredCreek) { hoveredCreek.img.classList.remove('creek-hover'); hoveredCreek = null; }
        openCreek = creek;
        creek.panel.classList.add('visible');
        creek.img.classList.add('creek-active');
        if (creek.ripple) creek.ripple.classList.add('creek-active');
        mapDimmer.classList.add('visible');
        titleEl.classList.add('title-hidden');
    }

    function closePanel() {
        if (!openCreek) return;
        openCreek.panel.classList.remove('visible');
        openCreek.img.classList.remove('creek-active');
        if (openCreek.ripple) openCreek.ripple.classList.remove('creek-active');
        mapDimmer.classList.remove('visible');
        openCreek = null;
        titleEl.classList.remove('title-hidden');
    }

    function pullToCreek(creek) {
        velX = velY = 0;
        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
        const vw = viewport.clientWidth, vh = viewport.clientHeight;
        const isMobile = vw <= 640;
        const zoomTo   = Math.min(isMobile ? creek.zoomTo * 0.5 : creek.zoomTo, MAX_SCALE);
        // Mobile: panel covers bottom 55vh, so centre creek in the upper 45%
        // Desktop: panel on right side, so push creek to creek.viewX from left
        const targetX  = isMobile ? 0.50 : creek.viewX;
        const targetY  = isMobile ? 0.45 * 0.5 : 0.50;
        const nx = clamp(vw * targetX - creek.centroid.x * zoomTo, vw - MAP_W * zoomTo, 0);
        const ny = clamp(vh * targetY - creek.centroid.y * zoomTo, vh - MAP_H * zoomTo, 0);
        container.style.transition = creekContainer.style.transition = 'transform 0.7s cubic-bezier(0.4, 0, 0.2, 1)';
        x = nx; y = ny; scale = zoomTo; targetScale = zoomTo;
        applyTransform();
        setTimeout(() => { container.style.transition = creekContainer.style.transition = ''; }, 750);
    }

    viewport.addEventListener('mousemove', e => {
        if (!isDragging && !openCreek) {
            const creek = creekAt(e.clientX, e.clientY);
            if (creek !== hoveredCreek) {
                if (hoveredCreek) hoveredCreek.img.classList.remove('creek-hover');
                if (creek)        creek.img.classList.add('creek-hover');
                hoveredCreek = creek;
            }
        }
    });

    // Click → fly to creek + show panel
    let pointerDownX = 0, pointerDownY = 0;

    viewport.addEventListener('click', e => {
        const wasDrag = Math.hypot(e.clientX - pointerDownX, e.clientY - pointerDownY) > 6;
        if (wasDrag) return;
        const creek = creekAt(e.clientX, e.clientY);
        if (creek) {
            pullToCreek(creek);
            openPanel(creek);
        } else {
            closePanel();
        }
    });

    // Current rendered transform
    let x = 0, y = 0, scale = 1;

    // Zoom animation target
    let targetScale  = 1;
    let zoomOriginX  = 0;
    let zoomOriginY  = 0;

    // Pan momentum
    let velX = 0, velY = 0;

    // Drag state
    let isDragging    = false;
    let lastMouseX    = 0, lastMouseY = 0;
    let moveHistory   = []; // {dx, dy, t}

    // Animation frame handle
    let rafId = null;

    // ── UI fade ───────────────────────────────────────────────────────────
    // Elements with class "ui-element" fade out on interaction and return
    // after 3 s of inactivity. Add the "ui-fade" class to trigger fade-out.

    const uiElements = document.querySelectorAll('.ui-element');
    let uiFadeTimer = null;

    function hideUI() {
        uiElements.forEach(el => el.classList.add('ui-fade'));
        clearTimeout(uiFadeTimer);
        uiFadeTimer = setTimeout(showUI, 1000);
        closePanel();
    }

    function showUI() {
        uiElements.forEach(el => el.classList.remove('ui-fade'));
    }

    // ── Render quality ────────────────────────────────────────────────────
    // Use fast rendering while interacting, restore crisp quality when idle.

    let renderQualityTimer = null;

    function setFastRendering() {
        mapImg.style.imageRendering = 'optimizeSpeed';
        clearTimeout(renderQualityTimer);
        renderQualityTimer = setTimeout(setCrispRendering, 150);
    }

    function setCrispRendering() {
        mapImg.style.imageRendering = '';
    }

    // ── Helpers ───────────────────────────────────────────────────────────

    function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

    // Minimum scale = cover the viewport (map always fills the screen)
    function minScale() {
        return Math.max(viewport.clientWidth / MAP_W, viewport.clientHeight / MAP_H);
    }

    // Clamp x/y so no edge of the map ever reveals the background
    function clampPosition() {
        const vw = viewport.clientWidth;
        const vh = viewport.clientHeight;
        x = clamp(x, vw - MAP_W * scale, 0);
        y = clamp(y, vh - MAP_H * scale, 0);
    }

    function fit() {
        const vw = viewport.clientWidth;
        const vh = viewport.clientHeight;
        // Cover the viewport and zoom in slightly so the map fills the screen
        scale = clamp(minScale() * 1.15, minScale(), MAX_SCALE);
        targetScale = scale;
        x = (vw - MAP_W * scale) / 2;
        y = (vh - MAP_H * scale) / 2;
        clampPosition();
        applyTransform();
    }

    function applyTransform() {
        const t = `translate(${x}px,${y}px) scale(${scale})`;
        container.style.transform = t;
        creekContainer.style.transform = t;
    }

    function startAnim() {
        if (!rafId) rafId = requestAnimationFrame(tick);
    }

    function tick() {
        let dirty = false;

        // ── Smooth zoom ──────────────────────────────────────────────────
        const diff = targetScale - scale;
        if (Math.abs(diff) > 0.0001) {
            const newScale = scale + diff * ZOOM_LERP;
            const ratio    = newScale / scale;
            x     = zoomOriginX - (zoomOriginX - x) * ratio;
            y     = zoomOriginY - (zoomOriginY - y) * ratio;
            scale = newScale;
            dirty = true;
        } else if (scale !== targetScale) {
            const ratio = targetScale / scale;
            x     = zoomOriginX - (zoomOriginX - x) * ratio;
            y     = zoomOriginY - (zoomOriginY - y) * ratio;
            scale = targetScale;
        }

        // ── Pan momentum ─────────────────────────────────────────────────
        if (!isDragging && (Math.abs(velX) > 0.05 || Math.abs(velY) > 0.05)) {
            x    += velX;
            y    += velY;
            velX *= FRICTION;
            velY *= FRICTION;
            dirty = true;
        }

        clampPosition();
        applyTransform();

        rafId = dirty ? requestAnimationFrame(tick) : null;
    }

    // ── Velocity from recent move history ─────────────────────────────────

    function pushMove(dx, dy) {
        const t = performance.now();
        moveHistory.push({ dx, dy, t });
        while (moveHistory.length && moveHistory[0].t < t - 100) {
            moveHistory.shift();
        }
    }

    function computeVelocity() {
        if (!moveHistory.length) { velX = velY = 0; return; }
        const now    = performance.now();
        const window = Math.max(now - moveHistory[0].t, 1);
        let sumX = 0, sumY = 0;
        for (const m of moveHistory) { sumX += m.dx; sumY += m.dy; }
        velX = (sumX / window) * 16.67;
        velY = (sumY / window) * 16.67;
    }

    // ── Mouse ─────────────────────────────────────────────────────────────

    viewport.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        e.preventDefault();
        isDragging   = true;
        velX = velY  = 0;
        moveHistory  = [];
        lastMouseX   = e.clientX;
        lastMouseY   = e.clientY;
        pointerDownX = e.clientX;
        pointerDownY = e.clientY;
        if (hoveredCreek) { hoveredCreek.img.classList.remove('creek-hover'); hoveredCreek = null; }
        viewport.classList.add('grabbing');
    });

    window.addEventListener('mousemove', e => {
        if (!isDragging) return;
        hideUI();
        setFastRendering();
        const dx = e.clientX - lastMouseX;
        const dy = e.clientY - lastMouseY;
        x += dx;
        y += dy;
        clampPosition();
        pushMove(dx, dy);
        lastMouseX = e.clientX;
        lastMouseY = e.clientY;
        applyTransform();
    });

    window.addEventListener('mouseup', () => {
        if (!isDragging) return;
        isDragging = false;
        viewport.classList.remove('grabbing');
        computeVelocity();
        startAnim();
    });

    window.addEventListener('mousedown', () => { velX = velY = 0; });

    // ── Wheel zoom ────────────────────────────────────────────────────────

    viewport.addEventListener('wheel', e => {
        e.preventDefault();
        hideUI();
        setFastRendering();

        const rect = viewport.getBoundingClientRect();
        zoomOriginX = e.clientX - rect.left;
        zoomOriginY = e.clientY - rect.top;

        let delta = e.deltaY;
        if (e.deltaMode === 1) delta *= 16;
        if (e.deltaMode === 2) delta *= 200;

        const factor = Math.exp(-delta * 0.0012);
        targetScale  = clamp(targetScale * factor, minScale(), MAX_SCALE);

        startAnim();
    }, { passive: false });

    // ── Touch ─────────────────────────────────────────────────────────────

    let touches          = {};
    let lastPinchDist    = 0;
    let lastMidX         = 0, lastMidY = 0;
    let touchMoveHistory = [];

    function updateTouchAnchors() {
        const ids = Object.keys(touches);
        if (ids.length >= 2) {
            const a = touches[ids[0]], b = touches[ids[1]];
            lastPinchDist = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
            lastMidX      = (a.clientX + b.clientX) / 2;
            lastMidY      = (a.clientY + b.clientY) / 2;
        } else if (ids.length === 1) {
            const t = touches[ids[0]];
            lastMidX = t.clientX;
            lastMidY = t.clientY;
            lastPinchDist = 0;
        }
    }

    viewport.addEventListener('touchstart', e => {
        e.preventDefault();
        velX = velY = 0;
        isDragging       = true;
        touchMoveHistory = [];

        // Track tap origin so the click handler can distinguish tap from drag
        if (e.touches.length === 1) {
            pointerDownX = e.touches[0].clientX;
            pointerDownY = e.touches[0].clientY;
        }

        for (const t of e.changedTouches) touches[t.identifier] = t;
        updateTouchAnchors();
    }, { passive: false });

    viewport.addEventListener('touchmove', e => {
        e.preventDefault();
        hideUI();
        setFastRendering();
        for (const t of e.changedTouches) touches[t.identifier] = t;

        const ids = Object.keys(touches);

        if (ids.length >= 2) {
            const a    = touches[ids[0]], b = touches[ids[1]];
            const dist = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
            const midX = (a.clientX + b.clientX) / 2;
            const midY = (a.clientY + b.clientY) / 2;
            const rect = viewport.getBoundingClientRect();

            // Pan first — panning has priority
            const dx = midX - lastMidX;
            const dy = midY - lastMidY;
            x += dx;
            y += dy;

            // Then zoom around the mid-point
            if (lastPinchDist > 1 && dist > 1) {
                const pinchFactor = dist / lastPinchDist;
                const ox  = midX - rect.left;
                const oy  = midY - rect.top;
                const ns  = clamp(scale * pinchFactor, minScale(), MAX_SCALE);
                const ratio = ns / scale;
                x     = ox - (ox - x) * ratio;
                y     = oy - (oy - y) * ratio;
                scale = ns;
                targetScale = ns;
            }

            lastPinchDist = dist;
            lastMidX      = midX;
            lastMidY      = midY;
            clampPosition();
            touchMoveHistory.push({ dx, dy, t: performance.now() });
            while (touchMoveHistory.length && touchMoveHistory[0].t < performance.now() - 100)
                touchMoveHistory.shift();

        } else if (ids.length === 1) {
            const t  = touches[ids[0]];
            const dx = t.clientX - lastMidX;
            const dy = t.clientY - lastMidY;
            x += dx;
            y += dy;
            clampPosition();
            lastMidX = t.clientX;
            lastMidY = t.clientY;
            touchMoveHistory.push({ dx, dy, t: performance.now() });
            while (touchMoveHistory.length && touchMoveHistory[0].t < performance.now() - 100)
                touchMoveHistory.shift();
        }

        applyTransform();
    }, { passive: false });

    viewport.addEventListener('touchend', e => {
        e.preventDefault();
        for (const t of e.changedTouches) delete touches[t.identifier];

        const ids = Object.keys(touches);

        if (ids.length === 0) {
            isDragging = false;

            // Tap detection — preventDefault() suppresses synthetic click on mobile,
            // so we handle creek/ripple taps here instead.
            if (e.changedTouches.length === 1) {
                const t = e.changedTouches[0];
                const wasDrag = Math.hypot(t.clientX - pointerDownX, t.clientY - pointerDownY) > 8;
                if (!wasDrag) {
                    const creek = creekAt(t.clientX, t.clientY) ?? creekAtRipple(t.clientX, t.clientY);
                    if (creek) {
                        pullToCreek(creek);
                        openPanel(creek);
                    } else {
                        closePanel();
                    }
                    return;
                }
            }

            if (touchMoveHistory.length) {
                const window = Math.max(performance.now() - touchMoveHistory[0].t, 1);
                let sumX = 0, sumY = 0;
                for (const m of touchMoveHistory) { sumX += m.dx; sumY += m.dy; }
                velX = (sumX / window) * 16.67;
                velY = (sumY / window) * 16.67;
            }
            startAnim();
        } else {
            updateTouchAnchors();
        }
    }, { passive: false });

    viewport.addEventListener('touchcancel', e => {
        for (const t of e.changedTouches) delete touches[t.identifier];
        isDragging = false;
        velX = velY = 0;
    }, { passive: false });

    // ── Reset button ──────────────────────────────────────────────────────

    document.getElementById('btn-reset').addEventListener('click', () => {
        closePanel();
        velX = velY = 0;
        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }

        const vw = viewport.clientWidth;
        const vh = viewport.clientHeight;
        const newScale = clamp(minScale() * 1.15, minScale(), MAX_SCALE);
        const newX = (vw - MAP_W * newScale) / 2;
        const newY = (vh - MAP_H * newScale) / 2;

        container.style.transition = creekContainer.style.transition = 'transform 0.55s cubic-bezier(0.4, 0, 0.2, 1)';
        x = newX; y = newY; scale = newScale; targetScale = newScale;
        applyTransform();
        setTimeout(() => { container.style.transition = creekContainer.style.transition = ''; }, 600);
    });

    // ── Randomize button ──────────────────────────────────────────────────

    let creekQueue = [];

    function getNextRandomCreek() {
        if (creekQueue.length === 0)
            creekQueue = [...CREEKS].sort(() => Math.random() - 0.5);
        // Avoid immediately repeating the currently open creek
        if (creekQueue[0] === openCreek && creekQueue.length > 1)
            creekQueue.push(creekQueue.shift());
        return creekQueue.shift();
    }

    document.getElementById('btn-randomize').addEventListener('click', () => {
        const creek = getNextRandomCreek();
        pullToCreek(creek);
        openPanel(creek);
    });

    // ── About overlay ─────────────────────────────────────────────────────

    const aboutOverlay   = document.getElementById('about-overlay');
    const aboutContainer = document.getElementById('about-container');
    const aboutWrapper   = document.getElementById('about-panels-wrapper');

    function toggleAbout() {
        aboutOverlay.classList.toggle('visible');
        if (!aboutOverlay.classList.contains('visible')) {
            aboutWrapper.classList.remove('cited-open');
        }
    }

    document.getElementById('btn-about').addEventListener('click', toggleAbout);

    aboutOverlay.addEventListener('click', e => {
        if (!aboutContainer.contains(e.target)) toggleAbout();
    });

    document.getElementById('btn-work-cited').addEventListener('click', () => {
        aboutWrapper.classList.add('cited-open');
    });

    document.getElementById('btn-back-cited').addEventListener('click', () => {
        aboutWrapper.classList.remove('cited-open');
    });

    // ── Init ──────────────────────────────────────────────────────────────

    fit();
    window.addEventListener('resize', fit);
})();
