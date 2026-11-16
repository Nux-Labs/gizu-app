"use client";

// Tool calls, inspired by Illos.dev (https://illos.dev/library/shader/tool-calls), adapted and restyled for Wildjury.
// One SVG, its field drawn live with WebGL by shader-runtime.ts beside this file: it plays once when it scrolls into view, holds its final frame, loops while hovered, and finishes its cycle when the pointer leaves. Without WebGL, or with reduced motion, the SVG's still shows.
import { useEffect, useRef, type CSSProperties } from "react";
import { mountShader } from "./shader-runtime";

const SVG = `<svg class="sh-tool-calls" xmlns="http://www.w3.org/2000/svg" width="720" height="460" viewBox="0 0 720 460" fill="none" stroke="#1daf9c" role="img" aria-labelledby="sh-tool-calls-t" aria-describedby="sh-tool-calls-d" data-illos="shader/tool-calls" data-illos-id="5ee5a12a592a"><!-- Illos.dev illustration "Tool calls" (shader/tool-calls), ID 5ee5a12a592a. License: https://illos.dev/license -->
<title id="sh-tool-calls-t">Tool calls</title>
<desc id="sh-tool-calls-d">A task card is handed to an agent, which calls three tools in turn, a search, a code runner and a calendar; each call goes out, the tool works and its result comes back, ticking a step on the card. Then the agent writes the answer and the task is marked done.</desc>
<style>@scope (svg.sh-tool-calls) {
:scope{--_ground:#ffffff;--_ink:#2a2a2a;--_ramp-1:#16645a;--_ramp-2:#1daf9c;--_ramp-3:#3fdec9;--_ramp-4:#c2f5ee;--_mark:#178c7d;--_spark:#0b463e}
@media (prefers-color-scheme: dark){:scope{--_ground:#101112;--_ink:#dadadc;--_ramp-1:#84ebdd;--_ramp-2:#3fdec9;--_ramp-3:#1daf9c;--_ramp-4:#1a7569;--_mark:#3fdec9;--_spark:#ffffff}}
:scope{stroke:none;--g:var(--illos-ground,var(--_ground));--k:var(--illos-ink,var(--_ink))}
.b0,.b1,.b2,.b3{fill:none;stroke-dasharray:7 2.4}
.b0{stroke:var(--illos-ramp-1,var(--_ramp-1))}.b1{stroke:var(--illos-ramp-2,var(--_ramp-2))}.b2{stroke:var(--illos-ramp-3,var(--_ramp-3))}.b3{stroke:var(--illos-ramp-4,var(--_ramp-4));opacity:.55}
.sc{fill:none;stroke:rgb(from color-mix(in srgb,var(--illos-ramp-4,var(--_ramp-4)) 18%,var(--g)) r g b/clamp(.33,(r + g + b)/382.5,1));stroke-width:.8}
.bm{fill:none;stroke:var(--illos-ramp-2,var(--_ramp-2));stroke-width:2.4;stroke-dasharray:5 2.4}
.sp{fill:none;stroke:var(--illos-spark,var(--_spark));stroke-width:1.2;stroke-linecap:round;opacity:.85}
.gr{stroke:rgb(from color-mix(in srgb,var(--k) 9%,var(--g)) r g b/clamp(.67,(r + g + b)/382.5,1));stroke-width:1}
.bx,.ln,.lv{fill:none;stroke:var(--illos-mark,var(--_mark));stroke-width:1.2}
.dot{fill:var(--illos-mark,var(--_mark))}.cf{fill:var(--illos-mark,var(--_mark))}
.ct{fill:none;stroke:var(--g);stroke-width:1.25;stroke-linecap:round;stroke-linejoin:round}
.tx{fill:none;stroke:var(--illos-mark,var(--_mark));stroke-width:1;stroke-linecap:round;stroke-linejoin:round}
@keyframes sh-tool-calls_dn{0%{opacity:1}6.667%{opacity:1;animation-timing-function:cubic-bezier(0.23,1,0.32,1)}9.333%{opacity:0}88.889%{opacity:0;animation-timing-function:cubic-bezier(0.23,1,0.32,1)}92.222%{opacity:1}100%{opacity:1}}
.dn{opacity:1;animation:sh-tool-calls_dn 4.5s linear both}
@keyframes sh-tool-calls_clock{0%{opacity:0}100%{opacity:0}}
.sh-clock{animation:sh-tool-calls_clock 4.5s linear both}
*{animation-iteration-count:1!important;animation-fill-mode:both!important;animation-play-state:var(--illos-play,running)!important}
@media (prefers-reduced-motion: reduce){*{animation:none!important}}
}
</style>
<g class="sh-still"><path class="sc" d="M4 0V460M11 0V460M18 0V460M25 0V460M32 0V460M39 0V460M46 0V460M53 0V460M60 0V460M67 0V460M74 0V460M81 0V460M88 0V460M95 0V460M102 0V460M109 0V460M116 0V460M123 0V460M130 0V460M137 0V460M144 0V460M151 0V460M158 0V460M165 0V460M172 0V460M179 0V460M186 0V460M193 0V460M200 0V460M207 0V460M214 0V460M221 0V460M228 0V460M235 0V460M242 0V460M249 0V460M256 0V460M263 0V460M270 0V460M277 0V460M284 0V460M291 0V460M298 0V460M305 0V460M312 0V460M319 0V460M326 0V460M333 0V460M340 0V460M347 0V460M354 0V460M361 0V460M368 0V460M375 0V460M382 0V460M389 0V460M396 0V460M403 0V460M410 0V460M417 0V460M424 0V460M431 0V460M438 0V460M445 0V460M452 0V460M459 0V460M466 0V460M473 0V460M480 0V460M487 0V460M494 0V460M501 0V460M508 0V460M515 0V460M522 0V460M529 0V460M536 0V460M543 0V460M550 0V460M557 0V460M564 0V460M571 0V460M578 0V460M585 0V460M592 0V460M599 0V460M606 0V460M613 0V460M620 0V460M627 0V460M634 0V460M641 0V460M648 0V460M655 0V460M662 0V460M669 0V460M676 0V460M683 0V460M690 0V460M697 0V460M704 0V460M711 0V460M718 0V460"/><path class="gr" d="M0 0V460M96 0V460M192 0V460M288 0V460M384 0V460M480 0V460M576 0V460M672 0V460M0 0H720M0 96H720M0 192H720M0 288H720M0 384H720"/><path class="b0" d="M53 206.8V213.8M53 225.6V232.6M53 244.4V251.4M130 159.8V166.8M228 225.6V232.6M270 216.2V242M277 206.8V242M284 206.8V242M291 216.2V242M298 216.2V232.6M326 263.2V270.2M340 225.6V232.6M452 291.4V298.4M550 291.4V298.4" stroke-width="3.6"/><path class="b1" d="M39 159.8V166.8M46 159.8V166.8M53 159.8V166.8M53 263.2V279.6M60 159.8V166.8M60 263.2V279.6M67 159.8V166.8M67 206.8V213.8M67 225.6V232.6M67 244.4V251.4M67 263.2V279.6M74 159.8V166.8M74 206.8V213.8M74 225.6V232.6M74 244.4V251.4M74 263.2V279.6M81 159.8V166.8M81 206.8V213.8M81 225.6V232.6M81 244.4V251.4M81 263.2V279.6M88 159.8V166.8M88 206.8V213.8M88 225.6V232.6M88 244.4V251.4M88 263.2V279.6M95 159.8V166.8M95 206.8V213.8M95 225.6V232.6M95 244.4V251.4M95 263.2V279.6M102 159.8V166.8M102 206.8V213.8M102 225.6V232.6M102 244.4V251.4M102 263.2V270.2M109 159.8V166.8M109 206.8V213.8M109 244.4V251.4M109 263.2V270.2M116 159.8V166.8M116 206.8V213.8M116 263.2V270.2M123 159.8V166.8M123 263.2V270.2M137 159.8V166.8M263 216.2V242M270 206.8V213.8M270 244.4V251.4M277 244.4V251.4M284 244.4V251.4M291 206.8V213.8M291 244.4V251.4M298 206.8V213.8M298 235V251.4M305 225.6V242M326 188V195M431 300.8V307.8M438 300.8V307.8M445 84.6V91.6M445 112.8V119.8M445 300.8V307.8M452 122.2V129.2M452 300.8V307.8M459 75.2V82.2M459 300.8V307.8M466 75.2V82.2M466 300.8V307.8M473 75.2V82.2M473 300.8V307.8M480 122.2V129.2M480 300.8V307.8M487 84.6V91.6M487 112.8V129.2M487 300.8V307.8M494 103.4V110.4M494 131.6V138.6M494 300.8V307.8M501 131.6V138.6M501 300.8V307.8M508 141V148M508 300.8V307.8M515 300.8V307.8M522 300.8V307.8M529 300.8V307.8M536 300.8V307.8M543 300.8V307.8M550 300.8V307.8M557 300.8V307.8M564 300.8V307.8M571 300.8V307.8" stroke-width="2.7"/><path class="b2" d="M53 178.6V195M60 178.6V195M67 178.6V195M74 178.6V195M81 178.6V195M88 178.6V195M95 178.6V195M102 178.6V185.6M109 178.6V185.6M116 178.6V185.6M221 225.6V232.6M228 206.8V223.2M228 235V251.4M235 197.4V204.4M235 253.8V260.8M242 188V195M242 225.6V232.6M242 263.2V270.2M249 178.6V185.6M249 206.8V213.8M249 244.4V251.4M249 272.6V279.6M256 206.8V251.4M263 188V213.8M263 244.4V270.2M270 197.4V204.4M270 253.8V260.8M270 282V289M277 169.2V176.2M277 197.4V204.4M277 253.8V260.8M277 282V289M284 169.2V176.2M284 188V204.4M284 253.8V270.2M284 282V289M291 169.2V176.2M291 197.4V204.4M291 253.8V260.8M291 282V289M298 197.4V204.4M305 206.8V223.2M305 244.4V251.4M312 178.6V185.6M312 206.8V251.4M312 272.6V279.6M319 206.8V213.8M319 225.6V232.6M319 244.4V251.4M319 263.2V270.2M326 197.4V204.4M333 206.8V213.8M333 225.6V232.6M333 244.4V260.8M431 188V195M431 206.8V213.8M431 225.6V232.6M431 244.4V251.4M431 263.2V270.2M431 319.6V326.6M431 338.4V345.4M431 357.2V364.2M438 94V110.4M438 319.6V326.6M438 338.4V345.4M438 357.2V364.2M445 94V101M445 188V195M452 75.2V82.2M452 188V195M452 319.6V326.6M452 338.4V345.4M452 357.2V364.2M459 122.2V129.2M459 188V195M459 206.8V213.8M459 263.2V270.2M459 319.6V326.6M459 338.4V345.4M459 357.2V364.2M466 188V195M466 206.8V213.8M466 263.2V270.2M473 122.2V129.2M473 188V195M473 206.8V213.8M473 225.6V232.6M473 244.4V251.4M473 263.2V270.2M473 319.6V326.6M473 338.4V345.4M473 357.2V364.2M480 75.2V82.2M480 188V195M480 206.8V213.8M480 225.6V232.6M480 244.4V251.4M480 263.2V270.2M480 319.6V326.6M480 338.4V345.4M480 357.2V364.2M487 188V195M487 206.8V213.8M487 225.6V232.6M487 244.4V251.4M487 263.2V270.2M494 94V101M494 122.2V129.2M494 188V195M494 206.8V213.8M494 225.6V232.6M494 244.4V251.4M494 263.2V270.2M494 319.6V326.6M494 338.4V345.4M494 357.2V364.2M501 141V148M501 188V195M501 206.8V213.8M501 225.6V232.6M501 244.4V251.4M501 263.2V270.2M501 319.6V326.6M501 338.4V345.4M501 357.2V364.2M508 188V195M508 206.8V213.8M508 225.6V232.6M508 244.4V251.4M508 263.2V270.2M515 188V195M515 206.8V213.8M515 225.6V232.6M515 244.4V251.4M515 263.2V270.2M515 319.6V326.6M515 338.4V345.4M515 357.2V364.2M522 188V195M522 206.8V213.8M522 244.4V251.4M522 263.2V270.2M522 319.6V326.6M522 338.4V345.4M522 357.2V364.2M529 206.8V213.8M529 244.4V251.4M529 263.2V270.2M536 244.4V251.4M536 319.6V326.6M536 338.4V345.4M536 357.2V364.2M543 244.4V251.4M543 319.6V326.6M543 338.4V345.4M543 357.2V364.2M550 244.4V251.4M557 244.4V251.4M557 319.6V326.6M557 338.4V345.4M557 357.2V364.2M564 244.4V251.4M564 319.6V326.6M564 338.4V345.4M564 357.2V364.2M571 244.4V251.4" stroke-width="1.8"/><path class="b3" d="M39 169.2V289M46 282V289M53 282V289M60 282V289M67 282V289M74 282V289M81 282V289M88 282V289M95 282V289M102 282V289M109 282V289M116 282V289M123 282V289M130 282V289M137 169.2V289M144 225.6V232.6M158 225.6V232.6M172 225.6V232.6M186 225.6V232.6M200 225.6V232.6M214 225.6V232.6M235 263.2V270.2M242 197.4V204.4M242 216.2V223.2M242 235V242M249 216.2V242M249 253.8V260.8M256 178.6V185.6M256 197.4V204.4M256 253.8V279.6M263 169.2V176.2M263 282V289M270 169.2V176.2M270 188V195M270 263.2V270.2M277 188V195M277 263.2V270.2M291 188V195M291 263.2V270.2M298 169.2V176.2M298 188V195M298 253.8V270.2M298 282V289M305 178.6V185.6M305 197.4V204.4M305 253.8V260.8M305 272.6V279.6M312 188V204.4M312 253.8V260.8M319 178.6V204.4M319 216.2V223.2M319 235V242M319 272.6V279.6M326 253.8V260.8M333 188V204.4M333 216.2V223.2M333 235V242M333 263.2V270.2M340 178.6V185.6M340 216.2V223.2M340 235V242M340 272.6V279.6M354 169.2V176.2M354 225.6V232.6M354 291.4V298.4M368 159.8V166.8M368 225.6V232.6M368 300.8V307.8M382 150.4V157.4M382 225.6V232.6M382 310.2V317.2M396 141V148M396 225.6V232.6M396 319.6V336M410 131.6V138.6M410 225.6V232.6M410 338.4V345.4M424 112.8V129.2M424 225.6V232.6M424 347.8V354.8M438 112.8V119.8M445 103.4V110.4M445 122.2V129.2M452 84.6V119.8M459 84.6V119.8M466 84.6V138.6M473 84.6V119.8M480 84.6V119.8M487 94V110.4M494 112.8V119.8M522 75.2V82.2M522 94V101M522 112.8V119.8M529 75.2V82.2M529 94V101M529 112.8V119.8M536 75.2V82.2M536 94V101M536 112.8V119.8M543 75.2V82.2M543 94V101M543 112.8V119.8M550 75.2V82.2M550 94V101M550 112.8V119.8M557 75.2V82.2M557 94V101M557 112.8V119.8M564 75.2V82.2M564 94V101M564 112.8V119.8M571 75.2V82.2M571 94V101M571 112.8V119.8M578 75.2V82.2M578 112.8V119.8M585 75.2V82.2" stroke-width="1.1"/><path class="sp" d="M53 228v1.2M130 162.2v1.2M270 237.4v1.2M277 209.2v1.2M277 218.6v1.2M277 228v1.2M277 237.4v1.2M284 209.2v1.2M284 237.4v1.2M291 218.6v1.2M291 237.4v1.2"/></g>
<g class="box"><path class="bx" pathLength="1" d="M210 157.1H354V301.1H210Z"/><circle class="dot" cx="210" cy="157.1" r="2.2"/><circle class="dot" cx="354" cy="157.1" r="2.2"/><circle class="dot" cx="210" cy="301.1" r="2.2"/><circle class="dot" cx="354" cy="301.1" r="2.2"/><g class="chip"><rect class="cf" x="210" y="157.1" width="46.8" height="14.9"/><path class="ct" d="M215 168L215 163.4L217.3 161.1L219.6 163.4L219.6 168M215 165.13L219.6 165.13M226.96 162.25L225.81 161.1L223.51 161.1L222.36 162.25L222.36 166.85L223.51 168L225.81 168L226.96 166.85L226.96 164.55L224.66 164.55M234.32 161.1L229.72 161.1L229.72 168L234.32 168M229.72 164.55L233.17 164.55M237.08 168L237.08 161.1L241.68 168L241.68 161.1M244.44 161.1L249.04 161.1M246.74 161.1L246.74 168"/></g></g><path class="tx" d="M431 380L434.2 380M432.6 380L432.6 384.8M436.92 380L438.52 380L439.32 380.8L439.32 384L438.52 384.8L436.92 384.8L436.12 384L436.12 380.8L436.92 380M442.04 380L443.64 380L444.44 380.8L444.44 384L443.64 384.8L442.04 384.8L441.24 384L441.24 380.8L442.04 380M446.36 380L446.36 384.8L449.56 384.8M454.68 380.8L453.88 380L452.28 380L451.48 380.8L451.48 381.6L452.28 382.4L453.88 382.4L454.68 383.2L454.68 384L453.88 384.8L452.28 384.8L451.48 384"/><g class="dn"><g class="chip"><rect class="cf" x="39" y="133.8" width="76.24" height="14.9"/><path class="ct" d="M44 137.8L48.6 137.8M46.3 137.8L46.3 144.7M51.36 144.7L51.36 140.1L53.66 137.8L55.96 140.1L55.96 144.7M51.36 141.83L55.96 141.83M63.32 138.95L62.17 137.8L59.87 137.8L58.72 138.95L58.72 140.1L59.87 141.25L62.17 141.25L63.32 142.4L63.32 143.55L62.17 144.7L59.87 144.7L58.72 143.55M66.08 137.8L66.08 144.7M70.68 137.8L66.08 142.4M67.8 141.25L70.68 144.7M80.8 137.8L80.8 144.7L84.25 144.7L85.4 143.55L85.4 138.95L84.25 137.8L80.8 137.8M89.31 137.8L91.61 137.8L92.76 138.95L92.76 143.55L91.61 144.7L89.31 144.7L88.16 143.55L88.16 138.95L89.31 137.8M95.52 144.7L95.52 137.8L100.12 144.7L100.12 137.8M107.48 137.8L102.88 137.8L102.88 144.7L107.48 144.7M102.88 141.25L106.33 141.25"/></g></g>
<rect class="sh-clock" width="0" height="0"/>
<metadata class="illos-field" data-cycle="4.5"><![CDATA[float field(vec2 p, float t) {
  if (p.x < 24.0 || p.x > 696.0 || p.y < 24.0 || p.y > 436.0) return 0.0;
  float ph = TAU * t / T;
  float v = 0.0;
  float c = floor((p.x - 4.0) / 7.0 + 0.5);
  float k = floor(p.y / 9.4);
  float clear = 1.0 - sm(0.300, 0.500, t); // the last task's marks, until the new task is written
  // the card
  if (c > 4.500 && c < 19.500 && k > 16.500 && k < 30.500) {
    float a = 0.0;
    float done = max(clear, sm(4.0, 4.060, t));
    if (k < 17.500) a = abs(c - 18.0) < 0.5 ? mix(0.25, 1.15, done) : 0.7; // title, check
    else if (c < 5.500 || c > 18.500 || k > 29.500) a = 0.25; // edges
    else if (abs(k - 19.0) < 0.5 || abs(k - 20.0) < 0.5) {
      float len = abs(k - 19.0) < 0.5 ? 9.0 : 6.0;
      if (c > 6.5 && c < 7.5 + len) a = 0.42 + 0.6 * exp(-pow(t - 0.380 - 0.03 * (c - 7.0), 2.0) / 0.003);
    }
    else if (abs(k - 22.0) < 0.5) {
      float on = max(clear, sm(1.750, 1.810, t));
      if (abs(c - 7.0) < 0.5) a = mix(0.25, 1.1, on);
      else if (c > 8.5 && c < 16.500) a = mix(0.25, 0.72, on);
    }
    else if (abs(k - 24.0) < 0.5) {
      float on = max(clear, sm(2.700, 2.760, t));
      if (abs(c - 7.0) < 0.5) a = mix(0.25, 1.1, on);
      else if (c > 8.5 && c < 14.500) a = mix(0.25, 0.72, on);
    }
    else if (abs(k - 26.0) < 0.5) {
      float on = max(clear, sm(3.650, 3.710, t));
      if (abs(c - 7.0) < 0.5) a = mix(0.25, 1.1, on);
      else if (c > 8.5 && c < 15.500) a = mix(0.25, 0.72, on);
    }
    else if (abs(k - 28.0) < 0.5 && c > 6.5 && c < 17.500) {
      float tw = 3.700 + 0.012 * (c - 7.0); // written left to right
      a = 0.72 * max(clear, step(tw, t));
      if (t > tw && t < tw + 0.06) a = 1.15;
    }
    else if (abs(k - 29.0) < 0.5 && c > 6.5 && c < 13.500) {
      float tw = 3.850 + 0.012 * (c - 7.0); // written left to right
      a = 0.72 * max(clear, step(tw, t));
      if (t > tw && t < tw + 0.06) a = 1.15;
    }
    v = max(v, a);
  }
  // the agent: awake from the hand-off until the answer is written
  float awake = sm(0.700, 0.800, t) * (1.0 - sm(4.0, 4.300, t));
  {
    vec2 d = p - vec2(282.0, 229.100);
    float r = length(d);
    float an = atan(d.y, d.x);
    // a churning core, an inner ring of twelve marks, a faint floor and the rim
    float churn = noise(d * 0.09 + vec2(3.0 * cos(ph), 3.0 * sin(ph)));
    v = max(v, blob(p, vec2(282.0, 229.100), 27.0, 1.35 + awake * 0.35 * (churn - 0.5)));
    // the marks turn one place while it is awake, so they end where they began
    if (abs(r - 38.0) < 4.5 && abs(fract(an / TAU * 12.0 + sm(0.750, 4.300, t)) - 0.5) > 0.3) v = max(v, mix(0.42, 0.72, awake));
    if (r > 28.0 && r < 50.0 && hash(floor(p / vec2(7.0, 9.4))) > 0.8) v = max(v, 0.2);
    v = max(v, 0.42 * exp(-pow(r - 56.0, 2.0) / 14.0));
  }
  // the ports on the rim, and the dotted links to the card and the tools
  v = max(v, blob(p, vec2(226.0, 229.100), 6.0, 1.05));
  v = max(v, blob(p, vec2(326.577, 195.204), 6.0, 1.05));
  v = max(v, blob(p, vec2(338.0, 229.100), 6.0, 1.05));
  v = max(v, blob(p, vec2(324.343, 265.748), 6.0, 1.05));
  if (mod(c, 2.0) < 0.5) {
    float ln = seg(p, vec2(147.0, 229.100), vec2(216.0, 229.100), 4.0, 0.22);
    ln = max(ln, seg(p, vec2(326.577, 195.204), vec2(436.0, 112.0), 5.0, 0.22));
    ln = max(ln, seg(p, vec2(338.0, 229.100), vec2(424.0, 229.100), 5.0, 0.22));
    ln = max(ln, seg(p, vec2(324.343, 265.748), vec2(424.0, 352.0), 5.0, 0.22));
    v = max(v, ln);
  }
  // the hand-off, card to agent, and each call: out along its link, then the result back
  {
    float u = clamp((t - 0.450) / 0.300, 0.0, 1.0);
    if (u > 0.0 && u < 1.0) v += blob(p, mix(vec2(147.0, 229.100), vec2(226.0, 229.100), ease(u)), 8.0, 1.1 * sm(0.0, 0.1, u) * (1.0 - sm(0.85, 1.0, u)));
  }
  {
    float uo = clamp((t - 0.800) / 0.330, 0.0, 1.0);
    float ub = clamp((t - 1.420) / 0.330, 0.0, 1.0);
    if (uo > 0.0 && uo < 1.0) v += blob(p, mix(vec2(326.577, 195.204), vec2(436.0, 112.0), ease(uo)), 8.0, 1.1 * sm(0.0, 0.1, uo) * (1.0 - sm(0.85, 1.0, uo)));
    if (ub > 0.0 && ub < 1.0) v += blob(p, mix(vec2(436.0, 112.0), vec2(326.577, 195.204), ease(ub)), 9.5, 1.15 * sm(0.0, 0.1, ub) * (1.0 - sm(0.85, 1.0, ub)));
  }
  {
    float uo = clamp((t - 1.750) / 0.330, 0.0, 1.0);
    float ub = clamp((t - 2.370) / 0.330, 0.0, 1.0);
    if (uo > 0.0 && uo < 1.0) v += blob(p, mix(vec2(338.0, 229.100), vec2(424.0, 229.100), ease(uo)), 8.0, 1.1 * sm(0.0, 0.1, uo) * (1.0 - sm(0.85, 1.0, uo)));
    if (ub > 0.0 && ub < 1.0) v += blob(p, mix(vec2(424.0, 229.100), vec2(338.0, 229.100), ease(ub)), 9.5, 1.15 * sm(0.0, 0.1, ub) * (1.0 - sm(0.85, 1.0, ub)));
  }
  {
    float uo = clamp((t - 2.700) / 0.330, 0.0, 1.0);
    float ub = clamp((t - 3.320) / 0.330, 0.0, 1.0);
    if (uo > 0.0 && uo < 1.0) v += blob(p, mix(vec2(324.343, 265.748), vec2(424.0, 352.0), ease(uo)), 8.0, 1.1 * sm(0.0, 0.1, uo) * (1.0 - sm(0.85, 1.0, uo)));
    if (ub > 0.0 && ub < 1.0) v += blob(p, mix(vec2(424.0, 352.0), vec2(324.343, 265.748), ease(ub)), 9.5, 1.15 * sm(0.0, 0.1, ub) * (1.0 - sm(0.85, 1.0, ub)));
  }
  // the tools: each lights only while it works, from the call's arrival until its result leaves
  float work0 = sm(1.130, 1.180, t) * (1.0 - sm(1.420, 1.540, t));
  float work1 = sm(2.080, 2.130, t) * (1.0 - sm(2.370, 2.490, t));
  float work2 = sm(3.030, 3.080, t) * (1.0 - sm(3.320, 3.440, t));
  float tw0 = 1.130;
  float tw1 = 2.080;
  float tw2 = 3.030;
  // search: a lens with a rim, its glass filling as it searches, a handle, and three result lines lit in turn
  {
    float r = length(p - vec2(466.0, 104.0));
    v = max(v, 0.72 * exp(-pow(r - 26.0, 2.0) / 18.0));
    if (r < 21.0) v = max(v, 0.18 + 0.5 * work0);
    v = max(v, seg(p, vec2(486.0, 124.0), vec2(506.0, 144.0), 5.0, 0.8));
    for (int j = 0; j < 3; j++) {
      float fj = float(j);
      float kk = 8.0 + 2.0 * fj;
      float len = fj < 0.5 ? 9.0 : fj < 1.5 ? 7.0 : 8.0;
      if (abs(k - kk) < 0.5 && c > 73.5 && c < 74.5 + len) v = max(v, 0.25 + 0.5 * work0 * sm(tw0 + 0.06 * fj, tw0 + 0.06 * fj + 0.05, t));
    }
  }
  // code: a gutter of line marks and indented lines, run top to bottom while it works
  if (c > 60.5 && c < 84.5 && k > 19.5 && k < 28.5 && mod(k, 2.0) < 0.5) {
    float j = (k - 20.0) / 2.0;
    float ind = j < 0.5 ? 0.0 : j < 1.5 ? 2.0 : j < 3.5 ? 4.0 : 2.0;
    float len = 6.0 + floor(9.0 * hash(vec2(j, 21.0)));
    float run = work1 * exp(-pow(t - tw1 - 0.05 - 0.05 * j, 2.0) / 0.004);
    if (c < 61.5) v = max(v, 0.42);
    else if (c > 62.5 + ind && c < 63.5 + ind + len) v = max(v, 0.42 + 0.3 * work1 + 0.4 * run);
  }
  // calendar: a header with two binding rings, a grid of days; the free slot lights while it is found
  {
    if (k > 31.5 && k < 32.5 && c > 60.5 && c < 81.5) v = max(v, 0.7);
    if (k > 30.5 && k < 31.5 && (abs(c - 64.0) < 0.5 || abs(c - 78.0) < 0.5)) v = max(v, 1.05);
    if (k > 33.5 && k < 39.5 && mod(k, 2.0) < 0.5 && c > 60.5 && c < 81.5 && mod(c - 61.0, 3.0) < 1.5) {
      bool slot = abs(k - 36.0) < 0.5 && c > 69.5 && c < 71.5;
      v = max(v, slot ? 0.42 + 0.7 * work2 * sm(tw2 + 0.08, tw2 + 0.14, t) : 0.42 + 0.2 * work2);
    }
  }
  return v;
}]]></metadata>
</svg>`;
const LIVE = "<style>.illos-live{position:relative}.illos-live>svg{position:relative}.illos-live .sh-still{visibility:hidden}.illos-field-canvas{position:absolute;inset:0;width:100%;height:100%;display:block}</style>";

export function IllosToolCalls({ className, style }: { className?: string; style?: CSSProperties }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return undefined;
    const stopPlay = playOnce(ref.current);
    const stopField = mountShader(ref.current);
    return () => {
      stopField();
      stopPlay();
    };
  }, []);
  return <div ref={ref} className={className} style={{ "--illos-play": "paused", ...style } as CSSProperties} dangerouslySetInnerHTML={{ __html: LIVE + SVG }} />;
}

/** Waits until half of it is in view, lets it play once, loops while hovered, and finishes its cycle when the pointer leaves. */
function playOnce(host: HTMLElement): () => void {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return () => {};
  let started = false;
  const animations = () => host.getAnimations({ subtree: true });
  const play = () => {
    if (!started) {
      started = true;
      host.style.setProperty("--illos-play", "running");
      return;
    }
    if (animations().some((a) => a.playState === "running")) return;
    for (const a of animations()) {
      a.currentTime = 0; // seek only: play() takes a CSS animation out of CSS control, and --illos-play: paused stops working
    }
  };
  let wasOut = true;
  const io = new IntersectionObserver(
    (entries) => {
      const inView = entries.some((e) => e.isIntersecting);
      if (inView && wasOut) play();
      wasOut = !inView;
    },
    { threshold: 0.5 },
  );
  io.observe(host);
  const hover = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  let hovering = false;
  let waiting = false;
  const loop = () => {
    if (waiting) return;
    const list = animations();
    if (!list.length) return;
    waiting = true;
    // Every step waits for a frame, so a run of instantly finished animations costs one restart per frame, never a spin.
    Promise.all(list.map((a) => a.finished)).then(
      () =>
        requestAnimationFrame(() => {
          waiting = false;
          if (!hovering) return; // the pointer left: hold the final frame
          for (const a of animations()) {
            a.currentTime = 0; // seek only: play() takes a CSS animation out of CSS control, and --illos-play: paused stops working
          }
          loop();
        }),
      () =>
        requestAnimationFrame(() => {
          waiting = false; // an animation was cancelled: pick the loop back up while the pointer is still over it
          if (hovering) loop();
        }),
    );
  };
  const onEnter = () => {
    hovering = true;
    play(); // starts it if it has not played; otherwise replays, never cutting into a running cycle
    loop();
  };
  const onLeave = () => {
    hovering = false;
  };
  if (hover) {
    host.addEventListener("mouseenter", onEnter);
    host.addEventListener("mouseleave", onLeave);
  }
  return () => {
    hovering = false;
    io.disconnect();
    if (hover) {
      host.removeEventListener("mouseenter", onEnter);
      host.removeEventListener("mouseleave", onLeave);
    }
  };
}
