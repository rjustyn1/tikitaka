import type { Locator, Page } from "@playwright/test";

/**
 * Playwright records the DOM via screencast, which never includes the OS
 * cursor. So the cursor is drawn *into* the page, and every click is preceded
 * by an interpolated mouse move — page.click() teleports, which would make the
 * overlay jump discontinuously and read as broken on video.
 */
const ENABLED = process.env.DEMO_CURSOR !== "0";

export async function installCursor(page: Page): Promise<void> {
  if (!ENABLED) return;
  await page.addInitScript(() => {
    const boot = () => {
      if (document.getElementById("__demo_cursor")) return;
      const style = document.createElement("style");
      style.textContent = `
        #__demo_cursor{position:fixed;top:0;left:0;width:22px;height:22px;margin:-11px 0 0 -11px;
          border-radius:50%;background:rgba(56,189,248,.30);border:2px solid rgba(56,189,248,.95);
          box-shadow:0 0 0 1px rgba(0,0,0,.35),0 2px 12px rgba(0,0,0,.4);pointer-events:none;
          z-index:2147483647;will-change:transform}
        .__demo_ripple{position:fixed;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;
          border:2px solid rgba(56,189,248,.95);pointer-events:none;z-index:2147483646;
          animation:__demo_r .55s ease-out forwards}
        @keyframes __demo_r{from{transform:scale(1);opacity:.95}to{transform:scale(3.6);opacity:0}}`;
      document.head.append(style);
      const dot = document.createElement("div");
      dot.id = "__demo_cursor";
      dot.style.transform = "translate(-200px,-200px)";
      document.body.append(dot);
      addEventListener("mousemove", (e) => {
        dot.style.transform = `translate(${e.clientX}px,${e.clientY}px)`;
      }, { passive: true });
      addEventListener("mousedown", (e) => {
        const r = document.createElement("div");
        r.className = "__demo_ripple";
        // left/top, not transform — the keyframe owns transform.
        r.style.left = `${e.clientX}px`;
        r.style.top = `${e.clientY}px`;
        document.body.append(r);
        setTimeout(() => r.remove(), 600);
      }, { passive: true });
    };
    if (document.readyState === "loading") addEventListener("DOMContentLoaded", boot);
    else boot();
  });
}

/**
 * Move the pointer visibly, then let Playwright own the click.
 *
 * Pressing at raw coordinates skips hit-testing: a bounding box measured before
 * a re-render can land on `.modal-backdrop`, whose onMouseDown closes the very
 * modal being filled in. Playwright's click re-resolves and re-checks the
 * element, and still dispatches a real mousedown — so the ripple fires anyway.
 */
export async function demoClick(page: Page, target: Locator, steps = 24): Promise<void> {
  await target.waitFor({ state: "visible" });
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps });
    await page.waitForTimeout(120);
  }
  await target.click();
}

/** delay 0 = paste instantly (long bodies); >0 = visible typing. */
export async function demoType(page: Page, target: Locator, text: string, delay = 16): Promise<void> {
  await demoClick(page, target);
  await target.fill("");
  if (delay > 0) await target.pressSequentially(text, { delay });
  else await target.fill(text);
}
