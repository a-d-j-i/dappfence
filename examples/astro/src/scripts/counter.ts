export function initCounter(containerId: string): void {
    const el = document.getElementById(containerId);
    if (!el) return;
    let count = 0;
    el.innerHTML = `
        <div style="display:flex;align-items:center;gap:1em;font-size:1.2em">
            <button id="df-dec" style="width:2em;height:2em;border-radius:50%;border:1px solid currentColor;cursor:pointer;background:none;font-size:1em">−</button>
            <span id="df-count" style="min-width:2em;text-align:center;font-weight:700">${count}</span>
            <button id="df-inc" style="width:2em;height:2em;border-radius:50%;border:1px solid currentColor;cursor:pointer;background:none;font-size:1em">+</button>
            <span style="font-size:0.75em;color:#888">loaded via dynamic import — verified by DappFence SW</span>
        </div>`;
    el.querySelector('#df-inc')?.addEventListener('click', () => {
        el.querySelector('#df-count')!.textContent = String(++count);
    });
    el.querySelector('#df-dec')?.addEventListener('click', () => {
        el.querySelector('#df-count')!.textContent = String(--count);
    });
}
