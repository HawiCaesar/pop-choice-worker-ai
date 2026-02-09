export const calculateCost = (promptTokens: number, completionTokens: number, model: string): number => {
	// Pricing as of Feb 2024
	const pricing: Record<string, { input: number; output: number }> = {
		'gpt-4o-mini': {
			input: 0.15 / 1_000_000, // $0.150 per 1M input tokens
			output: 0.6 / 1_000_000, // $0.600 per 1M output tokens
		},
		'text-embedding-3-small': {
			input: 0.02 / 1_000_000, // $0.020 per 1M tokens
			output: 0,
		},
	};

	const rates = pricing[model] || pricing['gpt-4o-mini'];
	return promptTokens * rates.input + completionTokens * rates.output;
};

export const calculateAverageScore = (results: Array<{ score: number }>): number => {
	if (results.length === 0) return 0;
	const sum = results.reduce((acc, r) => acc + r.score, 0);
	return sum / results.length;
};

export const calculateTopScore = (results: Array<{ score: number }>): number => {
	if (results.length === 0) return 0;
	return Math.max(...results.map((r) => r.score));
};

export const calculateMinScore = (results: Array<{ score: number }>): number => {
	if (results.length === 0) return 0;
	return Math.min(...results.map((r) => r.score));
};

export const generateId = (): string => {
	return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
};
