const DAY_MS = 24 * 60 * 60 * 1000;

function formatBotActivityTime(timestamp: number | undefined, now: Date = new Date(), locale?: string): string {
    if (timestamp === undefined || !Number.isFinite(timestamp)) {
        return '';
    }

    const activity = new Date(timestamp);
    const nowYear = now.getFullYear();
    const nowMonth = now.getMonth();
    const nowDate = now.getDate();
    const activityYear = activity.getFullYear();
    const activityMonth = activity.getMonth();
    const activityDateNumber = activity.getDate();
    const todayIndex = Date.UTC(nowYear, nowMonth, nowDate);
    const activityIndex = Date.UTC(activityYear, activityMonth, activityDateNumber);
    const dayDifference = Math.round((todayIndex - activityIndex) / DAY_MS);

    if (dayDifference === 0) {
        const formatter = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

        return formatter
            .format(activity);
    }

    if (dayDifference > 0 && dayDifference < 7) {
        const formatter = new Intl.DateTimeFormat(locale, { weekday: 'long' });

        return formatter
            .format(activity);
    }

    const formatter = new Intl.DateTimeFormat(locale, { dateStyle: 'short' });

    return formatter
        .format(activity);
}

export { formatBotActivityTime };
