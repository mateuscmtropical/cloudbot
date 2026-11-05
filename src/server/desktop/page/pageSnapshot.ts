interface PageSnapshot {
    title: string;
    url: string;
    text: string;
}

// Runs in the page's own world. Reads the title, the address and the visible text of the page.
function pageSnapshot(): PageSnapshot {
    const body = document.body as HTMLElement | null;

    return { title: document.title, url: location.href, text: body ? body.innerText : '' };
}

export { pageSnapshot };
export type { PageSnapshot };
