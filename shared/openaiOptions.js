function buildOpenAiTemperatureOptions(value = process.env.OPENAI_TEMPERATURE) {
    const configured = (value ?? '').trim();
    if (!configured) return {};

    const temperature = Number(configured);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
        throw new Error('OPENAI_TEMPERATURE must be blank or a number between 0 and 2.');
    }

    return { temperature };
}

module.exports = { buildOpenAiTemperatureOptions };
