// Runs in an isolated world. Only what is on the screen and not covered, such as by a dialog. The rest is listed after a scroll.
function pageClickableElements(selector: string, maxListed: number): Element[] {
    const isOnScreen = (element: Element): boolean => {
        const box = element.getBoundingClientRect();

        if (box.width === 0 || box.height === 0 || box.bottom <= 0 || box.right <= 0 || box.top >= innerHeight || box.left >= innerWidth) {
            return false;
        }

        const centerX = Math.max((box.left + box.right) / 2, 0);
        const centerY = Math.max((box.top + box.bottom) / 2, 0);
        const pointX = Math.min(centerX, innerWidth - 1);
        const pointY = Math.min(centerY, innerHeight - 1);
        const hit = document.elementFromPoint(pointX, pointY);

        return hit !== null && (element.contains(hit) || hit.contains(element));
    };
    const matches = [...document.querySelectorAll(selector)];

    return matches.filter(isOnScreen)
        .slice(0, maxListed);
}

export { pageClickableElements };
