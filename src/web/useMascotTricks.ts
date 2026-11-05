import { useEffect } from 'react';

import { subscribeToPointer } from './mascotPointer.ts';
import type { Point } from './mascotPointer.ts';
import { findOtherMascots, playTrick } from './mascotStage.ts';
import { ALL_TRICKS, pickPauseMs, pickTrickName } from './mascotTricks.ts';

// While the bot rests, its mascot in the chat header does a random trick now and then. Work, a hidden tab or another chat
// ends the trick at once and gives the mascot back.
function useMascotTricks(isResting: boolean, botId: string | undefined): void {
    useEffect(() => {
        if (!isResting || botId === undefined) {
            return undefined;
        }

        let isOver = false;
        let timer: number | undefined;
        let lastName: string | undefined;
        let pointer: Point | undefined;
        let cancelPlay = (): void => undefined;
        const stopPointer = subscribeToPointer((point) => {
            pointer = point;
        });

        function schedule(): void {
            const pauseValue = Math.random();
            const pauseMs = pickPauseMs(pauseValue);

            timer = window.setTimeout(playNext, pauseMs);
        }

        function playNext(): void {
            const otherMascots = findOtherMascots();
            const pickValue = Math.random();
            const name = pickTrickName(ALL_TRICKS, { otherCount: otherMascots.length, pointer }, lastName, pickValue);
            const trick = name === undefined ? undefined : ALL_TRICKS[name];
            const play = document.hidden || trick === undefined ? undefined : playTrick(trick.run, pointer);

            if (play === undefined) {
                schedule();

                return;
            }

            lastName = name;
            cancelPlay = play.cancel;
            void play.finished.then(() => {
                if (!isOver) {
                    schedule();
                }
            });
        }

        function handleVisibility(): void {
            if (document.hidden) {
                cancelPlay();
            }
        }

        // A trick is planned for the place things had when it started.
        function handleResize(): void {
            cancelPlay();
        }

        document.addEventListener('visibilitychange', handleVisibility);
        window.addEventListener('resize', handleResize);
        schedule();

        return () => {
            isOver = true;
            window.clearTimeout(timer);
            cancelPlay();
            stopPointer();
            document.removeEventListener('visibilitychange', handleVisibility);
            window.removeEventListener('resize', handleResize);
        };
    }, [isResting, botId]);
}

export { useMascotTricks };
