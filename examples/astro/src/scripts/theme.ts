const root = document.documentElement;
const stored = localStorage.getItem('theme');
if (stored === 'dark' || (!stored && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    root.classList.add('dark');
}

export function initThemeToggle(buttonId: string): void {
    document.getElementById(buttonId)?.addEventListener('click', () => {
        const dark = root.classList.toggle('dark');
        localStorage.setItem('theme', dark ? 'dark' : 'light');
    });
}
