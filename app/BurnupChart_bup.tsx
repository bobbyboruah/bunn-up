// app/BurnupChart.tsx
import type { BurnupModel } from './buildBurnupModel';

export function BurnupChart({
  model,
  adjustedNextScope,
}: {
  model: BurnupModel;
  adjustedNextScope?: number | null;
}) {
  const {
    targetScope,
    latestScope,
    sprintLengthDays,
    originMs,
    targetDateMs,
    sprints,
    projection,
  } = model;

  /* ---------- basic derived values ---------- */

  const totalScopeRaw =
    typeof targetScope === 'number' && targetScope > 0
      ? targetScope
      : typeof latestScope === 'number' && latestScope > 0
      ? latestScope
      : 1;

  const totalScope = totalScopeRaw > 0 ? totalScopeRaw : 1;

  const sprintDays =
    typeof sprintLengthDays === 'number' && sprintLengthDays > 0
      ? sprintLengthDays
      : 14;

  const msPerSprint = sprintDays * 24 * 60 * 60 * 1000;

  let targetIndex = 6;

  if (
    typeof originMs === 'number' &&
    typeof targetDateMs === 'number' &&
    targetDateMs > originMs
  ) {
    const idx = (targetDateMs - originMs) / msPerSprint;
    if (Number.isFinite(idx) && idx > 0) {
      targetIndex = idx;
    }
  }

  // How many sprints we want visible beyond the target date
  const extraSprints = 2;

  // How much to overshoot cone + scope vertically
  const extensionFactor = 1.1; // 10% further (used only for Y now)

  /* ---------- derive sprint history & projection indices ---------- */

  const allSprints = sprints ?? [];
  const closedSprints = allSprints.filter((s) => s.isClosed);
  const lastClosed =
    closedSprints.length > 0 ? closedSprints[closedSprints.length - 1]! : null;
  const lastClosedIndex = lastClosed ? lastClosed.index : 0;

  // Immediate next open sprint after the last closed sprint
  const nextOpenAfterLastClosed =
    lastClosed != null
      ? allSprints.find((s) => !s.isClosed && s.index > lastClosedIndex) ?? null
      : null;

  const proj = projection ?? ({} as BurnupModel['projection']);

  const hasProjection =
    !!proj &&
    proj.hasSignal &&
    proj.fromSprintIndex != null &&
    proj.fromDone != null &&
    proj.projectedDonePerSprint != null &&
    proj.projectedDonePerSprint > 0;

  // Y we project up to (top of cone)
  const extendedScopeBase = totalScope * extensionFactor;
  const extendedScope =
    lastClosed && lastClosed.cumDoneEnd > 0
      ? Math.max(extendedScopeBase, lastClosed.cumDoneEnd * 1.05)
      : extendedScopeBase;

  // Indices where the projected lines hit the extendedScope (for cone shape)
  let centralEndIdx: number | null = null;
  let fastEndIdx: number | null = null;
  let slowEndIdx: number | null = null;

  if (hasProjection) {
    const anchorIndex = proj.fromSprintIndex as number;
    const anchorValue = proj.fromDone as number;
    const vCentral = proj.projectedDonePerSprint as number;
    const vFast = vCentral * 1.2;
    const vSlow = vCentral * 0.8;
    const remainingToExtended = Math.max(0, extendedScope - anchorValue);

    const deltaIdxCentral =
      vCentral > 0 ? remainingToExtended / vCentral : extraSprints;
    const deltaIdxFast =
      vFast > 0 ? remainingToExtended / vFast : deltaIdxCentral;
    const deltaIdxSlow =
      vSlow > 0 ? remainingToExtended / vSlow : deltaIdxCentral;

    centralEndIdx = anchorIndex + deltaIdxCentral;
    fastEndIdx = anchorIndex + deltaIdxFast;
    slowEndIdx = anchorIndex + deltaIdxSlow;
  }

  // Base X-span: target + some extra
  let baseMaxIndex = targetIndex + extraSprints;

  // Ensure we include history in the visible window
  baseMaxIndex = Math.max(baseMaxIndex, lastClosedIndex + extraSprints);

  // This maxIndex drives horizontal scaling of the whole chart
  const maxIndex = baseMaxIndex;

  /* ---------- chart frame ---------- */

  const width = 1200;
  const height = 360; // keep your original dimensions

  const padLeft = -200;
  const padRight = -200;
  const padTop = 10;
  const padBottom = 46;

  // Y-axis ceiling: include cone, real scopes, and any adjusted next scope
  const maxScopeFromSprints =
    allSprints.length > 0
      ? Math.max(...allSprints.map((s) => s.scopeAtEnd))
      : 0;

  const adjustedScopeCeiling =
    typeof adjustedNextScope === 'number' && Number.isFinite(adjustedNextScope)
      ? adjustedNextScope
      : 0;

  const rawScopeCeiling = Math.max(
    totalScope,
    latestScope,
    maxScopeFromSprints,
    adjustedScopeCeiling,
    1
  );

  const rawMaxY = Math.max(extendedScope, rawScopeCeiling);
  const yStep =
    rawMaxY <= 40 ? 10 : rawMaxY <= 100 ? 20 : rawMaxY <= 500 ? 50 : 100;
  const maxY = Math.max(yStep, Math.ceil(rawMaxY / yStep) * yStep);

  const yTicks: number[] = [];
  for (let v = 0; v <= maxY + 1e-9; v += yStep) {
    yTicks.push(v);
  }

  const xForIndex = (idx: number) => {
    const span = maxIndex || 1;
    const t = idx / span;
    return padLeft + t * (width - padLeft - padRight);
  };

  const yForVal = (v: number) => {
    const t = v / maxY;
    const innerH = height - padTop - padBottom;
    return padTop + innerH * (1 - t);
  };

  const buildPath = (pts: { x: number; y: number }[]) => {
    if (!pts.length) return '';
    return pts.reduce(
      (acc, p, i) => (i === 0 ? `M ${p.x} ${p.y}` : `${acc} L ${p.x} ${p.y}`),
      ''
    );
  };

  /* ---------- geometry for scope, history & cone ---------- */

  const originPoint = { x: xForIndex(0), y: yForVal(0) };

  // Historical burn-up (solid red), from origin through each closed sprint
  const historicalPoints: { x: number; y: number }[] = [originPoint];
  for (const s of closedSprints) {
    historicalPoints.push({
      x: xForIndex(s.index),
      y: yForVal(s.cumDoneEnd),
    });
  }
  const historicalPath = buildPath(historicalPoints);

  // Scope polyline (green)
  //  - uses real scope for history
  //  - if adjustedNextScope is provided and we can anchor it, then:
  //    * draw to next open sprint with that value
  //    * keep flat at that value for all later sprints
  const scopePoints: { x: number; y: number }[] = [originPoint];

  const canApplyAdjustedScope =
    typeof adjustedNextScope === 'number' &&
    Number.isFinite(adjustedNextScope) &&
    lastClosed != null &&
    nextOpenAfterLastClosed != null;

  for (const s of allSprints) {
    let scopeValue = s.scopeAtEnd;

    if (canApplyAdjustedScope && nextOpenAfterLastClosed) {
      if (s.index === nextOpenAfterLastClosed.index) {
        // immediate next open sprint → use adjusted value
        scopeValue = adjustedNextScope as number;
      } else if (s.index > nextOpenAfterLastClosed.index) {
        // all further sprints → flat line at adjusted value
        scopeValue = adjustedNextScope as number;
      }
      // indices <= lastClosed.index keep their real scopeAtEnd
    }

    scopePoints.push({
      x: xForIndex(s.index),
      y: yForVal(scopeValue),
    });
  }

  const scopePath = buildPath(scopePoints);

  let idealPath = '';
  let fastPath = '';
  let slowPath = '';
  let coneFillPath = '';
  let anchorPoint: { x: number; y: number } | null = null; // for pulsating dot

  if (hasProjection && lastClosed) {
    // Cone starting at last closed sprint
    const anchorIndex = proj.fromSprintIndex as number;
    const anchorValue = proj.fromDone as number;
    anchorPoint = {
      x: xForIndex(anchorIndex),
      y: yForVal(anchorValue),
    };

    const centralIdx = centralEndIdx ?? anchorIndex + extraSprints;
    const fastIdx = fastEndIdx ?? centralIdx;
    const slowIdx = slowEndIdx ?? centralIdx;

    const centralEndPoint = {
      x: xForIndex(centralIdx),
      y: yForVal(extendedScope),
    };
    const fastEndPoint = {
      x: xForIndex(fastIdx),
      y: yForVal(extendedScope),
    };
    const slowEndPoint = {
      x: xForIndex(slowIdx),
      y: yForVal(extendedScope),
    };

    idealPath = buildPath([anchorPoint, centralEndPoint]);
    fastPath = buildPath([anchorPoint, fastEndPoint]);
    slowPath = buildPath([anchorPoint, slowEndPoint]);

    coneFillPath =
      `M ${anchorPoint.x} ${anchorPoint.y}` +
      ` L ${slowEndPoint.x} ${slowEndPoint.y}` +
      ` L ${fastEndPoint.x} ${fastEndPoint.y}` +
      ' Z';
  } else {
    // Fallback: origin-based cone if we don't have a usable projection
    const idealBaseIdx = targetIndex;
    const fastBaseIdx = targetIndex * 0.85;
    const slowBaseIdx = targetIndex * 1.15;

    const idealExtIdx = idealBaseIdx * extensionFactor;
    const fastExtIdx = fastBaseIdx * extensionFactor;
    const slowExtIdx = slowBaseIdx * extensionFactor;

    const idealEndPoint = {
      x: xForIndex(idealExtIdx),
      y: yForVal(extendedScope),
    };
    const fastEndPoint = {
      x: xForIndex(fastExtIdx),
      y: yForVal(extendedScope),
    };
    const slowEndPoint = {
      x: xForIndex(slowExtIdx),
      y: yForVal(extendedScope),
    };

    idealPath = buildPath([originPoint, idealEndPoint]);
    fastPath = buildPath([originPoint, fastEndPoint]);
    slowPath = buildPath([originPoint, slowEndPoint]);

    coneFillPath =
      `M ${originPoint.x} ${originPoint.y}` +
      ` L ${slowEndPoint.x} ${slowEndPoint.y}` +
      ` L ${fastEndPoint.x} ${fastEndPoint.y}` +
      ' Z';
  }

  // Scope level used specifically for the target marker (targetScope / latestScope)
  const scopeY = yForVal(totalScope);

  // Vertical "target date" marker on scope line
  const idealTargetPoint = {
    x: xForIndex(targetIndex),
    y: scopeY,
  };

  /* ---------- X-axis tick labels (dates per sprint) ---------- */

  const xTicks: { x: number; label: string }[] = [];
  const maxTickIndex = Math.floor(baseMaxIndex);

  if (sprints && sprints.length > 0) {
    // Use sprint END dates for tick labels (Excel-style).
    for (const s of sprints) {
      if (s.index > maxTickIndex) break;
      const d = new Date(s.endMs);
      const dd = String(d.getUTCDate()).padStart(2, '0');
      const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
      xTicks.push({ x: xForIndex(s.index), label: `${dd}/${mm}` });
    }
  } else if (typeof originMs === 'number') {
    // Fallback: origin-based ticks if we somehow have no sprints
    const tickCount = Math.floor(baseMaxIndex) + 1;
    for (let i = 0; i <= tickCount; i++) {
      const d = new Date(originMs + i * msPerSprint);
      const dd = String(d.getUTCDate()).padStart(2, '0');
      const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
      xTicks.push({ x: xForIndex(i), label: `${dd}/${mm}` });
    }
  } else {
    const tickCount = Math.floor(baseMaxIndex) + 1;
    for (let i = 0; i <= tickCount; i++) {
      xTicks.push({ x: xForIndex(i), label: String(i) });
    }
  }

  let targetLabel: string | null = null;

  if (typeof targetDateMs === 'number') {
    const d = new Date(targetDateMs);
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const yy = String(d.getUTCFullYear()).slice(2);
    targetLabel = `${dd}/${mm}/${yy}`;
  }

  /* ---------- legend placement ---------- */

  const legendWidth = 190;
  const legendHeight = 54;
  const legendX = 20;
  const legendY = 40;

  /* ---------- render ---------- */

  return (
    <svg
      style={{ width: '100%', height: '100%', display: 'block' }}
      viewBox={`0 0 ${width} ${height}`}
    >
      {/* Axes */}
      <line
        x1={padLeft}
        y1={padTop}
        x2={padLeft}
        y2={height - padBottom}
        stroke="#111827"
        strokeWidth={1.4}
      />
      <line
        x1={padLeft}
        y1={height - padBottom}
        x2={width - padRight}
        y2={height - padBottom}
        stroke="#111827"
        strokeWidth={1.4}
      />

      {/* Y grid + labels */}
      {yTicks.map((v) => {
        const y = yForVal(v);
        const isZero = v === 0;
        return (
          <g key={v}>
            <line
              x1={padLeft}
              y1={y}
              x2={width - padRight}
              y2={y}
              stroke={isZero ? '#9ca3af' : '#f3f4f6'}
              strokeWidth={isZero ? 1 : 1}
            />
            <text
              x={padLeft - 8}
              y={y + 3}
              fontSize={10}
              textAnchor="end"
              fill="#6b7280"
            >
              {v}
            </text>
          </g>
        );
      })}

      {/* Scope line (stories) – straight polyline, with optional adjusted next sprint */}
      {scopePath && (
        <path d={scopePath} fill="none" stroke="#16a34a" strokeWidth={2} />
      )}

      {/* Cone fill between faster/slower lines */}
      <path d={coneFillPath} fill="#dbeafe" fillOpacity={0.4} />

      {/* Faster / slower solid lines */}
      <path d={fastPath} fill="none" stroke="#3b82f6" strokeWidth={1.5} />
      <path d={slowPath} fill="none" stroke="#3b82f6" strokeWidth={1.5} />

      {/* Ideal (projected) dashed line */}
      <path
        d={idealPath}
        fill="none"
        stroke="#1d4ed8"
        strokeWidth={2}
        strokeDasharray="6 4"
      />

      {/* Historical burn-up (solid red) */}
      {closedSprints.length > 0 && (
        <path d={historicalPath} fill="none" stroke="#ef4444" strokeWidth={2} />
      )}

      {/* Dots on each closed-sprint point on the red line */}
      {closedSprints.map((s) => {
        const x = xForIndex(s.index);
        const y = yForVal(s.cumDoneEnd);
        return (
          <circle
            key={`hist-dot-${s.index}`}
            cx={x}
            cy={y}
            r={3}
            fill="#ffffff"
            stroke="#ef4444"
            strokeWidth={1.5}
          />
        );
      })}

      {/* Green dots on scope line for each closed sprint (raw scope) */}
      {closedSprints.map((s) => {
        const x = xForIndex(s.index);
        const y = yForVal(s.scopeAtEnd);
        return (
          <circle
            key={`scope-dot-${s.index}`}
            cx={x}
            cy={y}
            r={3}
            fill="#ffffff"
            stroke="#16a34a"
            strokeWidth={1.5}
          />
        );
      })}

      {/* Numeric labels on green scope dots (closed sprints) */}
      {closedSprints.map((s) => {
        const x = xForIndex(s.index);
        const y = yForVal(s.scopeAtEnd);
        return (
          <text
            key={`scope-label-${s.index}`}
            x={x}
            y={y - 6}
            fontSize={9}
            textAnchor="middle"
            fill="#16a34a"
            fontWeight={500}
          >
            {s.scopeAtEnd}
          </text>
        );
      })}

      {/* Label + dot for slider-managed scope (first open sprint after last closed) */}
      {canApplyAdjustedScope &&
        nextOpenAfterLastClosed &&
        typeof adjustedNextScope === 'number' &&
        Number.isFinite(adjustedNextScope) && (() => {
          const x = xForIndex(nextOpenAfterLastClosed.index);
          const y = yForVal(adjustedNextScope);
          return (
            <>
              <circle
                key="scope-adjust-dot"
                cx={x}
                cy={y}
                r={4}
                fill="#ffffff"
                stroke="#16a34a"
                strokeWidth={1.5}
              />
              <text
                key="scope-adjust-label"
                x={x}
                y={y - 8}
                fontSize={10}
                textAnchor="middle"
                fill="#16a34a"
                fontWeight={600}
              >
                {adjustedNextScope}
              </text>
            </>
          );
        })()}

      {/* Pulsating marker on last closed sprint (cone anchor) */}
      {anchorPoint && (
        <g>
          {/* solid centre dot */}
          <circle
            cx={anchorPoint.x}
            cy={anchorPoint.y}
            r={4}
            fill="#ef4444"
            stroke="#ffffff"
            strokeWidth={1}
          />
          {/* pulsing ring */}
          <circle
            cx={anchorPoint.x}
            cy={anchorPoint.y}
            r={6}
            fill="none"
            stroke="#ef4444"
            strokeWidth={1}
            opacity={0.7}
          >
            <animate
              attributeName="r"
              from="4"
              to="10"
              dur="1.6s"
              repeatCount="indefinite"
            />
            <animate
              attributeName="opacity"
              from="0.9"
              to="0"
              dur="1.6s"
              repeatCount="indefinite"
            />
          </circle>
        </g>
      )}

      {/* Target completion marker (vertical line + dot on scope level at target) */}
      <line
        x1={idealTargetPoint.x}
        y1={idealTargetPoint.y}
        x2={idealTargetPoint.x}
        y2={height - padBottom}
        stroke="#9ca3af"
        strokeDasharray="4 4"
      />
      <circle
        cx={idealTargetPoint.x}
        cy={idealTargetPoint.y}
        r={3}
        fill="#1d4ed8"
        stroke="white"
        strokeWidth={1}
      />

      {/* Date label only, in green, directly above the vertical marker */}
      {targetLabel && (
        <text
          x={idealTargetPoint.x}
          y={idealTargetPoint.y - 8}
          fontSize={11}
          textAnchor="middle"
          fill="#16a34a"
        >
          {targetLabel}
        </text>
      )}

      {/* X ticks */}
      {xTicks.map((t, i) => (
        <g key={`${t.x}-${i}`}>
          <line
            x1={t.x}
            y1={height - padBottom}
            x2={t.x}
            y2={height - padBottom + 4}
            stroke="#9ca3af"
          />
          <text
            x={t.x}
            y={height - padBottom + 16}
            fontSize={9}
            textAnchor="middle"
            fill="#6b7280"
          >
            {t.label}
          </text>
        </g>
      ))}

      {/* Legend card – top-left of chart */}
      <g transform={`translate(${legendX}, ${legendY})`}>
        <rect
          x={0}
          y={-10}
          width={legendWidth}
          height={legendHeight}
          rx={6}
          fill="#ffffff"
          fillOpacity={0.96}
          stroke="#e5e7eb"
        />
        <g transform="translate(8, 0)">
          <g>
            <line
              x1={0}
              y1={0}
              x2={22}
              y2={0}
              stroke="#16a34a"
              strokeWidth={2}
            />
            <text x={26} y={3} fontSize={10} fill="#6b7280">
              Scope (stories)
            </text>
          </g>
          <g transform="translate(0,14)">
            <line
              x1={0}
              y1={0}
              x2={22}
              y2={0}
              stroke="#1d4ed8"
              strokeWidth={2}
              strokeDasharray="6 4"
            />
            <text x={26} y={3} fontSize={10} fill="#6b7280">
              Projected burn-up
            </text>
          </g>
          <g transform="translate(0,28)">
            <rect
              x={0}
              y={-6}
              width={22}
              height={12}
              fill="#dbeafe"
              fillOpacity={0.6}
            />
            <text x={26} y={3} fontSize={10} fill="#6b7280">
              Faster / slower band
            </text>
          </g>
        </g>
      </g>
    </svg>
  );
}
