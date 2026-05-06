export function initBackToTop(buttonId: string): void {
    const btn = document.getElementById(buttonId);
    window.addEventListener(
        'scroll',
        () => {
            btn?.classList.toggle('visible', window.scrollY > 300);
        },
        { passive: true }
    );
    btn?.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
}
