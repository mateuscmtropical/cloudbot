import { lazy } from 'react';
import type { ComponentType, LazyExoticComponent } from 'react';

// A new deploy removes the old chunks, so an open tab can fail to load one. A reload picks up the new names.
function lazyPanel<Props extends object>(load: () => Promise<ComponentType<Props>>): LazyExoticComponent<ComponentType<Props>> {
    return lazy(async () => {
        try {
            return { default: await load() };
        } catch {
            window.location.reload();

            return new Promise<never>(() => undefined);
        }
    });
}

export { lazyPanel };
