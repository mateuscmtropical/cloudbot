// Raster images only. Files of these types show in the chat and are served inline. SVG and HTML never are, because a browser would run them.
const PREVIEW_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export { PREVIEW_IMAGE_TYPES };
