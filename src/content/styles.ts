/** Styles for the control bar. Lives inside a shadow root, so no scoping needed. */

export const BAR_CSS = `
:host {
  display: block;
  color: #fff;
  font: 500 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
}
* { box-sizing: border-box; margin: 0; padding: 0; }

.wrap {
  position: absolute;
  left: 0; right: 0; bottom: 0;
  padding: 34px 12px 10px;
  background: linear-gradient(to top, rgba(0,0,0,.82), rgba(0,0,0,.42) 55%, transparent);
  opacity: 0;
  transform: translateY(8px);
  transition: opacity .15s ease, transform .15s ease;
  pointer-events: none;
  user-select: none;
  -webkit-user-select: none;
}
.wrap.on { opacity: 1; transform: none; pointer-events: auto; }

/* ---- seek bar ---- */
.seek {
  position: relative;
  height: 16px;
  display: flex;
  align-items: center;
  cursor: pointer;
  touch-action: none;
}
.seek .track {
  position: relative;
  width: 100%;
  height: 3px;
  border-radius: 99px;
  background: rgba(255,255,255,.28);
  transition: height .12s ease;
}
.seek:hover .track, .seek.dragging .track { height: 5px; }
.seek .buffered, .seek .fill {
  position: absolute;
  left: 0; top: 0; bottom: 0;
  border-radius: 99px;
  width: 0;
}
.seek .buffered { background: rgba(255,255,255,.35); }
.seek .fill { background: #fff; }
.seek .thumb {
  position: absolute;
  top: 50%;
  left: 0;
  width: 11px; height: 11px;
  margin: -5.5px 0 0 -5.5px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0,0,0,.5);
  opacity: 0;
  transform: scale(.4);
  transition: opacity .12s ease, transform .12s ease;
  pointer-events: none;
}
.seek:hover .thumb, .seek.dragging .thumb { opacity: 1; transform: scale(1); }

/* Live streams and video whose metadata has not landed yet: say so rather than
   swallowing the click. */
.seek.disabled { cursor: default; opacity: .45; }
.seek.disabled:hover .track { height: 3px; }
.seek.disabled .thumb { display: none; }

/* ---- control row ---- */
.row {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 2px;
}
.btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px; height: 30px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: #fff;
  cursor: pointer;
  transition: background .12s ease;
}
.btn:hover { background: rgba(255,255,255,.16); }
.btn:active { background: rgba(255,255,255,.24); }
.btn:focus-visible { outline: 2px solid #fff; outline-offset: -2px; }
.btn svg { display: block; }

.time {
  font-variant-numeric: tabular-nums;
  font-size: 11.5px;
  letter-spacing: .2px;
  opacity: .92;
  padding: 0 4px;
  white-space: nowrap;
}
.spacer { flex: 1 1 auto; }

/* ---- volume ---- */
.vol { display: flex; align-items: center; }
.volslider {
  width: 0;
  opacity: 0;
  overflow: hidden;
  transition: width .16s ease, opacity .16s ease;
  cursor: pointer;
  touch-action: none;
  height: 30px;
  display: flex;
  align-items: center;
}
.vol:hover .volslider, .volslider.dragging { width: 68px; opacity: 1; }
.volslider .vtrack {
  position: relative;
  width: 60px;
  height: 3px;
  margin: 0 4px;
  border-radius: 99px;
  background: rgba(255,255,255,.3);
}
.volslider .vfill {
  position: absolute;
  left: 0; top: 0; bottom: 0;
  border-radius: 99px;
  background: #fff;
}
.volslider .vthumb {
  position: absolute;
  top: 50%; left: 0;
  width: 10px; height: 10px;
  margin: -5px 0 0 -5px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0,0,0,.5);
  pointer-events: none;
}

/* Fullscreen gets a roomier bar. */
:host(.fs) .wrap { padding: 60px 24px 20px; }
:host(.fs) .btn { width: 38px; height: 38px; }
:host(.fs) .btn svg { width: 22px; height: 22px; }
:host(.fs) .time { font-size: 13px; }
:host(.fs) .seek { height: 20px; }
:host(.fs) .volslider .vtrack { width: 80px; }
:host(.fs) .vol:hover .volslider, :host(.fs) .volslider.dragging { width: 88px; }
`;
