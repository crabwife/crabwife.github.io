(() => {
  "use strict";

  const canvas = document.getElementById("loss-surface-bg");

  if (!canvas) {
    return;
  }

  const context = canvas.getContext("2d", { alpha: true });

  if (!context) {
    return;
  }

  const reducedMotionQuery = window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  );
  const finePointerQuery = window.matchMedia(
    "(hover: hover) and (pointer: fine)"
  );
  const mobileQuery = window.matchMedia("(max-width: 768px)");

  /*
   * Responsive warped loss surface.
   *
   * The geometry has two separate layers:
   * 1. a permanently non-affine base mesh;
   * 2. a height field laid over that mesh.
   *
   * The mesh used for face shading is dense, while only every few
   * rows and columns are drawn. This makes the permanent warp legible
   * instead of visually collapsing back into tiny regular squares.
   */
  const settings = {
    gridColumns: 63,
    gridRows: 56,
    meshEveryColumns: 2,
    meshEveryRows: 2,

    // Extend the mesh past every viewport boundary before warping.
    // This prevents curved edges from exposing blank corner wedges.
    horizontalOverscan: 0.16,
    verticalOverscanTop: 0.08,
    verticalOverscanBottom: 0.20,

    // Base-grid deformation controls.
    permanentWarp: 0.68,
    handleWarpStrength: 0.72,
    warpCurl: 0.055,
    warpRippleX: 0.035,
    warpRippleY: 0.030,

    verticalRelief: 82,
    normalStrength: 2.45,
    perspectivePower: 1.42,
    nearWidth: 1.34,
    farWidth: 0.88,

    faceOpacity: 0.34,
    shadowOpacity: 0.11,
    highlightOpacity: 0.065,
    meshOpacity: 0.17,

    ambientSpeed: 0.00012,
    targetFramesPerSecond: 80,

    // Mobile-only autonomous motion. Desktop values above and below
    // remain unchanged.
    mobileAmbientSpeed: 0.000072,
    mobileTargetFramesPerSecond: 30,
    mobilePointerStrength: 0.22,
    mobilePointerSpringFrequency: 0.16,
    mobilePointerSpringDamping: 0.92,
    mobileLightSpringFrequency: 0.11,
    mobileLightSpringDamping: 0.94,
    mobileStrengthResponse: 0.34,
    mobileTargetIntervalMinimum: 4800,
    mobileTargetIntervalMaximum: 7800,
    mobileTargetMinimumX: 0.27,
    mobileTargetMaximumX: 0.73,
    mobileTargetMinimumY: 0.28,
    mobileTargetMaximumY: 0.72,
    mobileMicroDriftX: 0.014,
    mobileMicroDriftY: 0.011,
    mobileMicroDriftSpeed: 0.00031,

    pointerAmplitude: 0.76,
    pointerSpreadX: 0.44,
    pointerSpreadY: 0.38,

    // Damped-spring motion. Lower frequencies respond more slowly;
    // damping below 1 permits a small, graceful inertial overshoot.
    pointerSpringFrequency: 0.5,
    pointerSpringDamping: 0.68,
    lightSpringFrequency: 0.32,
    lightSpringDamping: 0.62,

    // Hold near the cursor briefly, then drift and return to neutral.
    idleHoldMilliseconds: 600,
    idleReturnMilliseconds: 4000,
    idleDriftX: 0.055,
    idleDriftY: 0.036,
    idleDriftSpeed: 0.00115,

    pointerStrengthInResponse: 1.25,
    pointerStrengthReturnResponse: 0.62,
    pointerStrengthExitResponse: 0.87,

    topEdgeFade: 0.10,
    bottomEdgeFade: 0.09,
    farDistanceFade: 0.22,

    contentPaddingTop: 0,
    contentPaddingBottom: 0
  };

  /*
   * Fixed displacement handles. These act like the control points of
   * a warped SVG mesh. Their influence is smooth and overlapping, so
   * cells vary in size, direction, and curvature across the page.
   */
  const warpHandles = [
    { u: 0.10, v: 0.15, du:  0.110, dv: -0.065, spread: 0.22 },
    { u: 0.39, v: 0.18, du: -0.090, dv:  0.100, spread: 0.25 },
    { u: 0.77, v: 0.20, du: -0.125, dv: -0.070, spread: 0.23 },
    { u: 0.91, v: 0.43, du:  0.070, dv:  0.115, spread: 0.20 },
    { u: 0.20, v: 0.53, du:  0.125, dv:  0.085, spread: 0.24 },
    { u: 0.55, v: 0.55, du: -0.130, dv: -0.115, spread: 0.27 },
    { u: 0.81, v: 0.72, du:  0.105, dv: -0.090, spread: 0.23 },
    { u: 0.34, v: 0.84, du:  0.115, dv: -0.070, spread: 0.22 },
    { u: 0.62, v: 0.91, du: -0.080, dv:  0.075, spread: 0.21 }
  ];

  let width = 0;
  let height = 0;
  let deviceScale = 1;
  let frameRequest = null;
  let previousFrameTime = 0;
  let latestPhase = 0;

  const pointer = {
    x: 0.5,
    y: 0.5,
    velocityX: 0,
    velocityY: 0,
    targetX: 0.5,
    targetY: 0.5,
    worldX: 0,
    worldY: 0,
    velocityWorldX: 0,
    velocityWorldY: 0,
    strength: 0,
    inside: false
  };

  const lightPointer = {
    x: 0.5,
    y: 0.5,
    velocityX: 0,
    velocityY: 0
  };

  const mobileMotion = {
    targetX: 0.5,
    targetY: 0.5,
    nextTargetTime: 0,
    phaseOffsetX: Math.random() * Math.PI * 2,
    phaseOffsetY: Math.random() * Math.PI * 2
  };

  let lastPointerMoveTime = -Infinity;
  let projectionLookup = [];

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function lerp(a, b, amount) {
    return a + (b - a) * amount;
  }

  function responseAlpha(responsePerSecond, deltaSeconds) {
    return 1 - Math.exp(
      -responsePerSecond * deltaSeconds
    );
  }

  function stepSpring(
    object,
    positionKey,
    velocityKey,
    target,
    frequency,
    damping,
    deltaSeconds
  ) {
    const angularFrequency =
      2 * Math.PI * frequency;

    const displacement =
      target - object[positionKey];

    const acceleration =
      angularFrequency *
        angularFrequency *
        displacement -
      2 *
        damping *
        angularFrequency *
        object[velocityKey];

    object[velocityKey] +=
      acceleration * deltaSeconds;

    object[positionKey] +=
      object[velocityKey] * deltaSeconds;
  }

  function chooseMobileTarget(timestamp) {
    mobileMotion.targetX = lerp(
      settings.mobileTargetMinimumX,
      settings.mobileTargetMaximumX,
      Math.random()
    );

    mobileMotion.targetY = lerp(
      settings.mobileTargetMinimumY,
      settings.mobileTargetMaximumY,
      Math.random()
    );

    mobileMotion.nextTargetTime =
      timestamp +
      lerp(
        settings.mobileTargetIntervalMinimum,
        settings.mobileTargetIntervalMaximum,
        Math.random()
      );
  }

  function getMobileInteractionTarget(timestamp) {
    if (
      mobileMotion.nextTargetTime === 0 ||
      timestamp >= mobileMotion.nextTargetTime
    ) {
      chooseMobileTarget(timestamp);
    }

    const driftPhase =
      timestamp *
      settings.mobileMicroDriftSpeed;

    return {
      x: clamp(
        mobileMotion.targetX +
          settings.mobileMicroDriftX *
            Math.sin(
              driftPhase +
              mobileMotion.phaseOffsetX
            ),
        settings.mobileTargetMinimumX,
        settings.mobileTargetMaximumX
      ),
      y: clamp(
        mobileMotion.targetY +
          settings.mobileMicroDriftY *
            Math.cos(
              driftPhase * 0.83 +
              mobileMotion.phaseOffsetY
            ),
        settings.mobileTargetMinimumY,
        settings.mobileTargetMaximumY
      ),
      strength: settings.mobilePointerStrength
    };
  }

  function getInteractionTarget(timestamp) {
    if (mobileQuery.matches) {
      return getMobileInteractionTarget(timestamp);
    }

    if (!pointer.inside) {
      return {
        x: 0.5,
        y: 0.5,
        strength: 0
      };
    }

    const idleMilliseconds =
      timestamp - lastPointerMoveTime;

    if (
      idleMilliseconds <=
      settings.idleHoldMilliseconds
    ) {
      return {
        x: pointer.targetX,
        y: pointer.targetY,
        strength: 1
      };
    }

    const returnProgress =
      smoothstep(
        settings.idleHoldMilliseconds,
        settings.idleHoldMilliseconds +
          settings.idleReturnMilliseconds,
        idleMilliseconds
      );

    const driftEnvelope =
      Math.sin(
        Math.PI * returnProgress
      );

    const driftPhase =
      timestamp *
      settings.idleDriftSpeed;

    const baseX =
      lerp(
        pointer.targetX,
        0.5,
        returnProgress
      );

    const baseY =
      lerp(
        pointer.targetY,
        0.5,
        returnProgress
      );

    return {
      x:
        baseX +
        settings.idleDriftX *
          driftEnvelope *
          Math.sin(
            driftPhase +
            pointer.targetY * 3.1
          ),
      y:
        baseY +
        settings.idleDriftY *
          driftEnvelope *
          Math.cos(
            driftPhase * 0.83 +
            pointer.targetX * 2.7
          ),
      strength:
        1 - 0.88 * returnProgress
    };
  }

  function smoothstep(edge0, edge1, value) {
    const amount = clamp(
      (value - edge0) / Math.max(edge1 - edge0, 0.000001),
      0,
      1
    );

    return amount * amount * (3 - 2 * amount);
  }

  function mixColor(first, second, amount) {
    return [
      Math.round(lerp(first[0], second[0], amount)),
      Math.round(lerp(first[1], second[1], amount)),
      Math.round(lerp(first[2], second[2], amount))
    ];
  }

  function scaleColor(color, factor) {
    return color.map((channel) =>
      clamp(Math.round(channel * factor), 0, 255)
    );
  }

  function normalizeVector(x, y, z) {
    const length = Math.hypot(x, y, z) || 1;

    return {
      x: x / length,
      y: y / length,
      z: z / length
    };
  }

  function gaussian(
    x,
    y,
    centerX,
    centerY,
    spreadX,
    spreadY = spreadX
  ) {
    const differenceX = (x - centerX) / spreadX;
    const differenceY = (y - centerY) / spreadY;

    return Math.exp(
      -(differenceX * differenceX + differenceY * differenceY)
    );
  }

  function getVisibleRegion() {
    const header =
      document.querySelector("#quarto-header") ||
      document.querySelector(".navbar");

    const footer =
      document.querySelector(".nav-footer") ||
      document.querySelector("footer");

    let top = 0;
    let bottom = height;

    if (header) {
      const headerBounds = header.getBoundingClientRect();

      if (headerBounds.bottom > 0 && headerBounds.top < height) {
        top = clamp(headerBounds.bottom, 0, height);
      }
    }

    if (footer) {
      const footerBounds = footer.getBoundingClientRect();

      if (footerBounds.top > 0 && footerBounds.top < height) {
        bottom = clamp(footerBounds.top, top, height);
      }
    }

    top += settings.contentPaddingTop;
    bottom -= settings.contentPaddingBottom;

    return {
      top: clamp(top, 0, height),
      bottom: clamp(bottom, top, height),
      height: Math.max(bottom - top, 1)
    };
  }

  function shouldAnimate() {
    return (
      !reducedMotionQuery.matches &&
      !document.hidden
    );
  }

  function resizeCanvas() {
    width = window.innerWidth;
    height = window.innerHeight;
    deviceScale = Math.min(window.devicePixelRatio || 1, 2);

    canvas.width = Math.round(width * deviceScale);
    canvas.height = Math.round(height * deviceScale);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    context.setTransform(
      deviceScale,
      0,
      0,
      deviceScale,
      0,
      0
    );
  }

  function inversePerspectiveDepth(relativeY) {
    return Math.pow(
      clamp(relativeY, 0, 1),
      1 / settings.perspectivePower
    );
  }

  function warpBaseCoordinates(u, v) {
    const centeredX = u - 0.5;
    const centeredY = v - 0.5;

    let displacementU = 0;
    let displacementV = 0;

    for (const handle of warpHandles) {
      const influence = gaussian(
        u,
        v,
        handle.u,
        handle.v,
        handle.spread
      );

      displacementU +=
        settings.handleWarpStrength *
        handle.du *
        influence;

      displacementV +=
        settings.handleWarpStrength *
        handle.dv *
        influence;
    }

    /*
     * Coupled low-frequency waves prevent the handle field from
     * looking like a handful of isolated dents.
     */
    displacementU +=
      settings.warpRippleX *
      Math.sin(
        Math.PI * 1.35 * v +
        0.85 * Math.sin(Math.PI * 1.10 * u)
      );

    displacementU +=
      0.035 *
      Math.sin(
        Math.PI * 2.30 * u -
        Math.PI * 0.75 * v +
        0.40
      );

    displacementV +=
      settings.warpRippleY *
      Math.sin(
        Math.PI * 1.25 * u -
        0.70 * Math.cos(Math.PI * 1.15 * v)
      );

    displacementV +=
      0.032 *
      Math.cos(
        Math.PI * 2.05 * v +
        Math.PI * 0.85 * u -
        0.30
      );

    /*
     * A broad curl bends both coordinate families. Unlike a simple
     * shear, this changes cell angles and areas throughout the field.
     */
    const radiusSquared =
      centeredX * centeredX +
      centeredY * centeredY;

    const curlAngle =
      settings.warpCurl *
      Math.exp(-1.15 * radiusSquared) *
      (
        0.60 +
        0.50 * Math.sin(Math.PI * v) -
        0.28 * centeredX
      );

    const cosAngle = Math.cos(curlAngle);
    const sinAngle = Math.sin(curlAngle);

    const curledX =
      centeredX * cosAngle -
      centeredY * sinAngle;

    const curledY =
      centeredX * sinAngle +
      centeredY * cosAngle;

    const warpedU =
      0.5 +
      curledX +
      settings.permanentWarp * displacementU;

    const warpedV =
      0.5 +
      curledY +
      settings.permanentWarp * displacementV;

    return {
      u,
      v,
      warpedU,
      warpedV,
      worldX: lerp(-2.45, 2.45, warpedU),
      worldY: lerp(-2.12, 2.12, warpedV)
    };
  }

  function surfaceValue(x, y, phase) {
    const firstBasin =
      -0.92 *
      gaussian(
        x,
        y,
        0.48 + 0.07 * Math.sin(phase * 0.55),
        -0.18 + 0.05 * Math.cos(phase * 0.42),
        0.68,
        0.52
      );

    const secondBasin =
      -0.52 *
      gaussian(
        x,
        y,
        -0.82 + 0.05 * Math.cos(phase * 0.48),
        0.60 + 0.06 * Math.sin(phase * 0.38),
        0.50,
        0.58
      );

    const broadRidge =
      0.78 *
      gaussian(
        x,
        y,
        -0.72 + 0.06 * Math.sin(phase * 0.44),
        -0.60 + 0.04 * Math.cos(phase * 0.52),
        0.76,
        0.48
      );

    const saddle =
      0.32 *
      Math.sin(
        1.30 * x -
        0.82 * y +
        phase * 0.42
      ) *
      Math.cos(
        0.58 * x +
        1.12 * y -
        phase * 0.26
      );

    let value =
      firstBasin +
      secondBasin +
      broadRidge +
      saddle +
      0.05 * x -
      0.035 * y;

    if (pointer.strength > 0.001) {
      /*
       * Continuous signed response: upper content raises and lower
       * content depresses, without a one-frame sign flip at halfway.
       */
      const signedDirection =
        Math.tanh(
          (0.5 - pointer.y) * 4.0
        );

      const positionalStrength =
        0.70 +
        0.30 *
        Math.min(
          1,
          Math.abs(pointer.y - 0.5) * 2
        );

      value +=
        settings.pointerAmplitude *
        signedDirection *
        positionalStrength *
        pointer.strength *
        gaussian(
          x,
          y,
          pointer.worldX,
          pointer.worldY,
          settings.pointerSpreadX,
          settings.pointerSpreadY
        );
    }

    return value;
  }

  function projectPoint(
    warped,
    surfaceHeight,
    region
  ) {
    const depth = Math.pow(
      clamp(warped.warpedV, 0, 1),
      settings.perspectivePower
    );

    const rowWidth = lerp(
      settings.farWidth,
      settings.nearWidth,
      depth
    );

    /*
     * warpedU and warpedV drive the projection directly. This is the
     * main difference from adding a small offset to a regular grid.
     */
    const x =
      width * 0.5 +
      (warped.warpedU - 0.5) *
      width *
      rowWidth *
      1.18;

    const baseY =
      region.top +
      warped.warpedV *
      region.height;

    const reliefScale =
      settings.verticalRelief *
      lerp(0.44, 1, depth);

    return {
      x,
      y: baseY - surfaceHeight * reliefScale,
      baseY,
      depth
    };
  }

  function lookupWorldCoordinates(
    normalizedX,
    normalizedY,
    region
  ) {
    if (projectionLookup.length === 0) {
      return {
        worldX: lerp(-2.45, 2.45, normalizedX),
        worldY: lerp(-2.12, 2.12, normalizedY)
      };
    }

    const screenX =
      normalizedX * width;

    const screenY =
      region.top +
      normalizedY * region.height;

    let closest =
      projectionLookup[0];

    let closestDistance =
      Infinity;

    for (const point of projectionLookup) {
      const differenceX =
        (point.screenX - screenX) /
        Math.max(width, 1);

      const differenceY =
        (point.screenY - screenY) /
        Math.max(region.height, 1);

      const distance =
        differenceX * differenceX +
        differenceY * differenceY;

      if (distance < closestDistance) {
        closestDistance = distance;
        closest = point;
      }
    }

    return {
      worldX: closest.worldX,
      worldY: closest.worldY
    };
  }

  function edgeFade(relativeY) {
    const topFade = smoothstep(
      0,
      settings.topEdgeFade,
      relativeY
    );

    const bottomFade =
      1 -
      smoothstep(
        1 - settings.bottomEdgeFade,
        1,
        relativeY
      );

    return topFade * bottomFade;
  }

  function distanceFade(depth) {
    return lerp(
      settings.farDistanceFade,
      1,
      smoothstep(0, 0.78, depth)
    );
  }

  function drawScene(phase) {
    latestPhase = phase;
    context.clearRect(0, 0, width, height);

    const region = getVisibleRegion();

    if (region.height <= 2) {
      return;
    }

    const cream = [243, 235, 221];
    const burgundy = [88, 24, 31];
    const indigo = [79, 93, 140];
    const sage = [89, 106, 87];
    const gold = [214, 168, 75];

    /*
     * The light slowly orbits, then responds strongly to the cursor.
     * This makes the shading visibly alive even when the surface
     * deformation itself is subtle.
     */
    const pointerLightStrength =
      0.25 + 0.75 * pointer.strength;

    const lightDirection = normalizeVector(
      -0.88 +
        0.34 * Math.sin(phase * 0.76) +
        (lightPointer.x - 0.5) *
          1.85 *
          pointerLightStrength,
      -0.62 +
        0.26 * Math.cos(phase * 0.61) +
        (lightPointer.y - 0.5) *
          1.45 *
          pointerLightStrength,
      1.02
    );

    const points = [];
    const nextProjectionLookup = [];

    for (
      let row = 0;
      row <= settings.gridRows;
      row += 1
    ) {
      points[row] = [];

      for (
        let column = 0;
        column <= settings.gridColumns;
        column += 1
      ) {
        const u =
          lerp(
            -settings.horizontalOverscan,
            1 + settings.horizontalOverscan,
            column / settings.gridColumns
          );

        const v =
          lerp(
            -settings.verticalOverscanTop,
            1 + settings.verticalOverscanBottom,
            row / settings.gridRows
          );

        const warped =
          warpBaseCoordinates(u, v);

        const value =
          surfaceValue(
            warped.worldX,
            warped.worldY,
            phase
          );

        const projected =
          projectPoint(
            warped,
            value,
            region
          );

        points[row][column] = {
          ...warped,
          value,
          projected
        };

        nextProjectionLookup.push({
          screenX: projected.x,
          screenY: projected.baseY,
          worldX: warped.worldX,
          worldY: warped.worldY
        });
      }
    }

    projectionLookup =
      nextProjectionLookup;

    context.save();
    context.beginPath();
    context.rect(
      0,
      region.top,
      width,
      region.height
    );
    context.clip();

    /*
     * Faces are rendered from perceived distance toward the viewer.
     */
    for (
      let row = 0;
      row < settings.gridRows;
      row += 1
    ) {
      for (
        let column = 0;
        column < settings.gridColumns;
        column += 1
      ) {
        const p00 = points[row][column];
        const p10 = points[row][column + 1];
        const p11 = points[row + 1][column + 1];
        const p01 = points[row + 1][column];

        const tangentX = {
          x: p10.worldX - p00.worldX,
          y: p10.worldY - p00.worldY,
          z:
            (p10.value - p00.value) *
            settings.normalStrength
        };

        const tangentY = {
          x: p01.worldX - p00.worldX,
          y: p01.worldY - p00.worldY,
          z:
            (p01.value - p00.value) *
            settings.normalStrength
        };

        let normal = normalizeVector(
          tangentX.y * tangentY.z -
            tangentX.z * tangentY.y,
          tangentX.z * tangentY.x -
            tangentX.x * tangentY.z,
          tangentX.x * tangentY.y -
            tangentX.y * tangentY.x
        );

        if (normal.z < 0) {
          normal = {
            x: -normal.x,
            y: -normal.y,
            z: -normal.z
          };
        }

        const lambert = clamp(
          normal.x * lightDirection.x +
          normal.y * lightDirection.y +
          normal.z * lightDirection.z,
          0,
          1
        );

        const meanValue =
          (
            p00.value +
            p10.value +
            p11.value +
            p01.value
          ) / 4;

        const elevation = clamp(
          (meanValue + 1.30) / 2.60,
          0,
          1
        );

        let terrainTint;

        if (elevation < 0.48) {
          terrainTint = mixColor(
            indigo,
            sage,
            elevation / 0.48
          );
        } else {
          terrainTint = mixColor(
            sage,
            burgundy,
            (elevation - 0.48) / 0.52
          );
        }

        const tintStrength =
          0.15 +
          0.14 *
          Math.abs(elevation - 0.5) *
          2;

        const terrainColor =
          mixColor(
            cream,
            terrainTint,
            tintStrength
          );

        /*
         * A multiplicative light term creates genuine tonal range.
         * Separate shadow and gold-highlight overlays then make the
         * light motion conspicuous through the canvas opacity.
         */
        const lightFactor =
          0.72 +
          0.42 * lambert;

        const litColor =
          scaleColor(
            terrainColor,
            lightFactor
          );

        const centerBaseY =
          (
            p00.projected.baseY +
            p10.projected.baseY +
            p11.projected.baseY +
            p01.projected.baseY
          ) / 4;

        const relativeY =
          (centerBaseY - region.top) /
          region.height;

        const meanDepth =
          (
            p00.projected.depth +
            p10.projected.depth +
            p11.projected.depth +
            p01.projected.depth
          ) / 4;

        const fade =
          edgeFade(relativeY) *
          distanceFade(meanDepth);

        if (fade <= 0.001) {
          continue;
        }

        context.beginPath();
        context.moveTo(
          p00.projected.x,
          p00.projected.y
        );
        context.lineTo(
          p10.projected.x,
          p10.projected.y
        );
        context.lineTo(
          p11.projected.x,
          p11.projected.y
        );
        context.lineTo(
          p01.projected.x,
          p01.projected.y
        );
        context.closePath();

        context.fillStyle =
          `rgba(${litColor[0]}, ${litColor[1]}, ${litColor[2]}, ${
            settings.faceOpacity * fade
          })`;
        context.fill();

        const shadowAmount =
          Math.pow(1 - lambert, 1.35) *
          settings.shadowOpacity *
          fade;

        if (shadowAmount > 0.002) {
          context.fillStyle =
            `rgba(${indigo[0]}, ${indigo[1]}, ${indigo[2]}, ${shadowAmount})`;
          context.fill();
        }

        const highlightAmount =
          Math.pow(lambert, 3.2) *
          settings.highlightOpacity *
          fade;

        if (highlightAmount > 0.002) {
          context.fillStyle =
            `rgba(${gold[0]}, ${gold[1]}, ${gold[2]}, ${highlightAmount})`;
          context.fill();
        }
      }
    }

    context.lineJoin = "round";
    context.lineCap = "round";

    /*
     * Draw only selected interior lines. Each selected line still uses
     * every high-resolution point, so it remains smoothly curved.
     */
    for (
      let row = settings.meshEveryRows;
      row < settings.gridRows;
      row += settings.meshEveryRows
    ) {
      const rowDepth =
        points[row][
          Math.floor(settings.gridColumns / 2)
        ].projected.depth;

      const rowBaseY =
        points[row][
          Math.floor(settings.gridColumns / 2)
        ].projected.baseY;

      const relativeY =
        (rowBaseY - region.top) /
        region.height;

      const fade =
        edgeFade(relativeY) *
        distanceFade(rowDepth);

      context.beginPath();

      for (
        let column = 0;
        column <= settings.gridColumns;
        column += 1
      ) {
        const point =
          points[row][column].projected;

        if (column === 0) {
          context.moveTo(point.x, point.y);
        } else {
          context.lineTo(point.x, point.y);
        }
      }

      context.strokeStyle =
        `rgba(${sage[0]}, ${sage[1]}, ${sage[2]}, ${
          settings.meshOpacity * fade
        })`;

      context.lineWidth =
        lerp(0.72, 1.22, rowDepth);

      context.stroke();
    }

    for (
      let column = settings.meshEveryColumns;
      column < settings.gridColumns;
      column += settings.meshEveryColumns
    ) {
      context.beginPath();

      let accumulatedFade = 0;
      let fadeCount = 0;

      for (
        let row = 0;
        row <= settings.gridRows;
        row += 1
      ) {
        const point =
          points[row][column];

        const relativeY =
          (
            point.projected.baseY -
            region.top
          ) /
          region.height;

        accumulatedFade +=
          edgeFade(relativeY) *
          distanceFade(
            point.projected.depth
          );

        fadeCount += 1;

        if (row === 0) {
          context.moveTo(
            point.projected.x,
            point.projected.y
          );
        } else {
          context.lineTo(
            point.projected.x,
            point.projected.y
          );
        }
      }

      const fade =
        accumulatedFade /
        Math.max(fadeCount, 1);

      context.strokeStyle =
        `rgba(${burgundy[0]}, ${burgundy[1]}, ${burgundy[2]}, ${
          settings.meshOpacity *
          0.78 *
          fade
        })`;

      context.lineWidth = 0.92;
      context.stroke();
    }

    context.restore();
  }

  function animate(timestamp) {
    frameRequest = null;

    if (!shouldAnimate()) {
      drawScene(0);
      return;
    }

    frameRequest =
      window.requestAnimationFrame(animate);

    const frameInterval =
      1000 /
      (
        mobileQuery.matches
          ? settings.mobileTargetFramesPerSecond
          : settings.targetFramesPerSecond
      );

    if (
      timestamp - previousFrameTime <
      frameInterval
    ) {
      return;
    }

    const deltaSeconds = clamp(
      (timestamp - previousFrameTime) / 1000,
      0.001,
      0.050
    );

    previousFrameTime = timestamp;

    const interactionTarget =
      getInteractionTarget(timestamp);

    const region =
      getVisibleRegion();

    const interactionWorldTarget =
      lookupWorldCoordinates(
        interactionTarget.x,
        interactionTarget.y,
        region
      );

    const pointerSpringFrequency =
      mobileQuery.matches
        ? settings.mobilePointerSpringFrequency
        : settings.pointerSpringFrequency;

    const pointerSpringDamping =
      mobileQuery.matches
        ? settings.mobilePointerSpringDamping
        : settings.pointerSpringDamping;

    const lightSpringFrequency =
      mobileQuery.matches
        ? settings.mobileLightSpringFrequency
        : settings.lightSpringFrequency;

    const lightSpringDamping =
      mobileQuery.matches
        ? settings.mobileLightSpringDamping
        : settings.lightSpringDamping;

    stepSpring(
      pointer,
      "x",
      "velocityX",
      interactionTarget.x,
      pointerSpringFrequency,
      pointerSpringDamping,
      deltaSeconds
    );

    stepSpring(
      pointer,
      "y",
      "velocityY",
      interactionTarget.y,
      pointerSpringFrequency,
      pointerSpringDamping,
      deltaSeconds
    );

    stepSpring(
      pointer,
      "worldX",
      "velocityWorldX",
      interactionWorldTarget.worldX,
      pointerSpringFrequency,
      pointerSpringDamping,
      deltaSeconds
    );

    stepSpring(
      pointer,
      "worldY",
      "velocityWorldY",
      interactionWorldTarget.worldY,
      pointerSpringFrequency,
      pointerSpringDamping,
      deltaSeconds
    );

    stepSpring(
      lightPointer,
      "x",
      "velocityX",
      interactionTarget.x,
      lightSpringFrequency,
      lightSpringDamping,
      deltaSeconds
    );

    stepSpring(
      lightPointer,
      "y",
      "velocityY",
      interactionTarget.y,
      lightSpringFrequency,
      lightSpringDamping,
      deltaSeconds
    );

    const strengthResponse =
      mobileQuery.matches
        ? settings.mobileStrengthResponse
        : !pointer.inside
          ? settings.pointerStrengthExitResponse
          : interactionTarget.strength < 0.95
            ? settings.pointerStrengthReturnResponse
            : settings.pointerStrengthInResponse;

    pointer.strength +=
      (
        interactionTarget.strength -
        pointer.strength
      ) *
      responseAlpha(
        strengthResponse,
        deltaSeconds
      );

    pointer.x = clamp(pointer.x, -0.12, 1.12);
    pointer.y = clamp(pointer.y, -0.12, 1.12);
    lightPointer.x = clamp(
      lightPointer.x,
      -0.12,
      1.12
    );
    lightPointer.y = clamp(
      lightPointer.y,
      -0.12,
      1.12
    );

    drawScene(
      timestamp *
      (
        mobileQuery.matches
          ? settings.mobileAmbientSpeed
          : settings.ambientSpeed
      )
    );
  }

  function stopAnimation() {
    if (frameRequest !== null) {
      window.cancelAnimationFrame(
        frameRequest
      );

      frameRequest = null;
    }
  }

  function updateAnimationState() {
    stopAnimation();

    if (shouldAnimate()) {
      previousFrameTime = 0;

      if (mobileQuery.matches) {
        mobileMotion.nextTargetTime = 0;
      }

      frameRequest =
        window.requestAnimationFrame(
          animate
        );
    } else {
      pointer.strength = 0;
      drawScene(0);
    }
  }

  function updatePointer(event) {
    if (!finePointerQuery.matches) {
      return;
    }

    const region =
      getVisibleRegion();

    pointer.inside =
      event.clientY >= region.top &&
      event.clientY <= region.bottom;

    pointer.targetX = clamp(
      event.clientX /
        Math.max(width, 1),
      0,
      1
    );

    const relativeY = clamp(
      (
        event.clientY -
        region.top
      ) /
        region.height,
      0,
      1
    );

    // Store actual screen-relative height. The world-space target
    // is recovered from the nearest projected base-mesh point.
    pointer.targetY =
      relativeY;

    if (pointer.inside) {
      lastPointerMoveTime =
        performance.now();
    }
  }

  function handlePointerLeave() {
    pointer.inside = false;
  }

  function handleResize() {
    resizeCanvas();
    updateAnimationState();
  }

  function handleGeometryChange() {
    if (!shouldAnimate()) {
      drawScene(latestPhase);
    }
  }

  resizeCanvas();
  drawScene(0);
  updateAnimationState();

  window.addEventListener(
    "resize",
    handleResize,
    { passive: true }
  );

  window.addEventListener(
    "scroll",
    handleGeometryChange,
    { passive: true }
  );

  window.addEventListener(
    "pointermove",
    updatePointer,
    { passive: true }
  );

  document.documentElement.addEventListener(
    "pointerleave",
    handlePointerLeave,
    { passive: true }
  );

  document.addEventListener(
    "visibilitychange",
    updateAnimationState
  );

  reducedMotionQuery.addEventListener(
    "change",
    updateAnimationState
  );

  mobileQuery.addEventListener(
    "change",
    updateAnimationState
  );

  window.addEventListener(
    "beforeunload",
    stopAnimation
  );
})();
