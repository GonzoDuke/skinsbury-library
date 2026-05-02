/**
 * Carnegie tartan SVGs — sidebar logo + sidebar accent stripe.
 *
 * The thread count (Y/4 G4 R4 G4 R4 G12 K12 R4 B12 R4 B4 R4 B/6) is
 * simplified for the on-screen sizes. The five clan colors at moderate
 * opacity produce the cross-hatch grid that reads as plaid without
 * overwhelming the "C" glyph that sits on top.
 *
 *   Navy   #1B3A5C  (base + B threads)
 *   Green  #2D5A3A  (G threads)
 *   Red    #B83232  (R threads)
 *   Black  #141414  (K threads)
 *   Gold   #C4A35A  (Y threads)
 *
 * The viewBox is laid out at 64 units to match retina (2× of the 32px
 * display size). Stripe positions and widths are integers in this
 * grid, so on a 2× display each rectangle edge lands on a device-pixel
 * boundary. `shape-rendering="crispEdges"` on the tartan group tells
 * the renderer to snap rather than antialias the rectangle edges, which
 * keeps the pattern from going fuzzy on standard-DPI screens.
 */
const NAVY = '#1B3A5C';
const GREEN = '#2D5A3A';
const RED = '#B83232';
const BLACK = '#141414';
const GOLD = '#C4A35A';

/** 32×32 rounded square with a 64-unit-precise tartan + a centered white "C". */
export function TartanLogo({ size = 32 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <defs>
        <clipPath id="carnegie-tartan-logo-clip">
          <rect width="64" height="64" rx="16" />
        </clipPath>
      </defs>
      <g clipPath="url(#carnegie-tartan-logo-clip)" shapeRendering="crispEdges">
        {/* Base */}
        <rect width="64" height="64" fill={NAVY} />

        {/* Horizontal stripes (warp). 64-unit grid; integer coords. */}
        <rect x="0" y="4"  width="64" height="4"  fill={GOLD} opacity="0.55" />
        <rect x="0" y="14" width="64" height="6"  fill={GREEN} opacity="0.5" />
        <rect x="0" y="26" width="64" height="10" fill={BLACK} opacity="0.55" />
        <rect x="0" y="42" width="64" height="6"  fill={RED} opacity="0.55" />
        <rect x="0" y="54" width="64" height="4"  fill={GOLD} opacity="0.55" />

        {/* Vertical stripes (weft). Same grid + colors. */}
        <rect x="6"  y="0" width="4"  height="64" fill={GOLD} opacity="0.4" />
        <rect x="18" y="0" width="6"  height="64" fill={GREEN} opacity="0.4" />
        <rect x="30" y="0" width="10" height="64" fill={BLACK} opacity="0.45" />
        <rect x="46" y="0" width="6"  height="64" fill={RED} opacity="0.4" />
        <rect x="58" y="0" width="4"  height="64" fill={GOLD} opacity="0.4" />
      </g>

      {/* "C" glyph. Anti-aliased text is the right call here — sharp
          edges on the tartan, smooth curves on the letter. paint-order:
          stroke gives a faint dark halo so the letter stays readable
          over the busiest crossings. */}
      <text
        x="32"
        y="44"
        textAnchor="middle"
        fontFamily='"JetBrains Mono", ui-monospace, monospace'
        fontSize="32"
        fontWeight="600"
        fill="#FFFFFF"
        style={{ paintOrder: 'stroke', stroke: 'rgba(20,20,20,0.55)', strokeWidth: 1.4 }}
      >
        C
      </text>
    </svg>
  );
}

/**
 * Full-width, 4px-tall sidebar accent stripe. Pattern tile is 64px
 * wide so the design lives on a 64-pixel grid; `shape-rendering`
 * snaps edges so the bands don't blur on either standard or 2× DPI.
 */
export function TartanStripe({ height = 4 }: { height?: number }) {
  const TILE = 64;
  return (
    <svg
      width="100%"
      height={height}
      viewBox={`0 0 ${TILE} ${height}`}
      preserveAspectRatio="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      style={{ display: 'block' }}
    >
      <defs>
        <pattern
          id="carnegie-tartan-stripe-tile"
          patternUnits="userSpaceOnUse"
          width={TILE}
          height={height}
        >
          <rect width={TILE} height={height} fill={NAVY} />
          <rect x="2"  y="0" width="2" height={height} fill={GOLD}  opacity="0.85" />
          <rect x="8"  y="0" width="4" height={height} fill={GREEN} opacity="0.85" />
          <rect x="16" y="0" width="3" height={height} fill={RED}   opacity="0.9" />
          <rect x="24" y="0" width="6" height={height} fill={BLACK} opacity="0.95" />
          <rect x="34" y="0" width="3" height={height} fill={RED}   opacity="0.9" />
          <rect x="42" y="0" width="4" height={height} fill={GREEN} opacity="0.85" />
          <rect x="50" y="0" width="2" height={height} fill={GOLD}  opacity="0.85" />
        </pattern>
      </defs>
      <rect
        width={TILE}
        height={height}
        fill="url(#carnegie-tartan-stripe-tile)"
        shapeRendering="crispEdges"
      />
    </svg>
  );
}
