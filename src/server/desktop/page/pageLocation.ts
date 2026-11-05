// Runs in an isolated world or the page's own world. The origin of the page, such as https://github.com.
function pageOrigin(): string {
    return location.origin;
}

// Runs in an isolated world or the page's own world. The full address of the page.
function pageUrl(): string {
    return location.href;
}

export { pageOrigin, pageUrl };
