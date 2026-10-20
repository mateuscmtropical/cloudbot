async function checkApiKey(key: string): Promise<number> {
    const signal = AbortSignal.timeout(10000);
    const response = await fetch('https://api.anthropic.com/v1/models', {
        headers: { 'anthropic-version': '2023-06-01', 'x-api-key': key },
        // Fetch keeps custom headers on a redirect, so a redirect would send the key to another host.
        redirect: 'error',
        signal,
    });

    await response.body?.cancel();

    return response.status;
}

export { checkApiKey };
