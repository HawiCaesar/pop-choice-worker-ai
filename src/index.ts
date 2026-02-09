import OpenAI from 'openai';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '../convex/_generated/api';
import { Opik } from 'opik';
import { calculateCost, calculateAverageScore, calculateTopScore, calculateMinScore } from './observability/metrics';

function corsHeaders(origin: string | null, env: Env): Record<string, string> {
	const allowedOrigins = getAllowedOrigins(env);
	const isAllowed = isOriginAllowed(origin, allowedOrigins);

	return {
		'Access-Control-Allow-Origin': isAllowed && origin ? origin : '',
		'Access-Control-Allow-Methods': 'POST, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type, Authorization',
		'Access-Control-Allow-Credentials': 'true',
		'Content-Type': 'application/json',
	};
}

const getAllowedOrigins = (env: Env): string[] => {
	if (!env.ALLOWED_ORIGINS) {
		// Fallback for local development if not set
		return ['http://localhost:5173'];
	}
	return env.ALLOWED_ORIGINS.split(',').map((origin: string) => origin.trim());
};

const isOriginAllowed = (origin: string | null, allowedOrigins: string[]): boolean => {
	if (!origin) return false;
	return allowedOrigins.includes(origin);
};

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const { headers } = request;
		const origin = headers.get('origin');
		const allowedOrigins = getAllowedOrigins(env);
		const allowedHeaders = corsHeaders(origin, env);

		// Handle OPTIONS preflight request
		if (request.method === 'OPTIONS') {
			return new Response(null, {
				status: 204,
				headers: { ...allowedHeaders },
			});
		}

		// Validate origin before processing
		if (!isOriginAllowed(origin, allowedOrigins)) {
			return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
				status: 403,
				headers: { ...allowedHeaders },
			});
		}

		if (request.method !== 'POST') {
			return new Response(JSON.stringify({ error: `Method ${request.method} not allowed` }), {
				status: 405,
				headers: { ...allowedHeaders },
			});
		}

		const openai = new OpenAI({
			apiKey: env.OPENAI_API_KEY,
			baseURL: env.CLOUDFLARE_GATEWAY_URL,
		});

		const convex = new ConvexHttpClient(env.CONVEX_URL);

		// Initialize Opik observability
		const opikClient = new Opik({
			apiKey: env.OPIK_API_KEY,
			apiUrl: 'https://www.comet.com/opik/api',
			projectName: env.OPIK_PROJECT_NAME,
			workspaceName: env.OPIK_WORKSPACE_NAME,
		});

		const requestData = (await request.json()) as {
			movieSetUpPreferences: { numberOfPeople: string; time: string };
			peopleResponses: [{ userResponses: string; stringifiedQueryAndResponses: string }];
		};
		const movieSetUpPreferences = requestData.movieSetUpPreferences;
		const availableRunTime = movieSetUpPreferences.time;

		const numberOfPeople = movieSetUpPreferences.numberOfPeople;

		const peopleResponses = requestData.peopleResponses;
		const allParticipantsResponses = peopleResponses.map((person) => person.userResponses).join('\n');
		const allParticipantsResponsesAndAnswers = peopleResponses.map((person) => person.stringifiedQueryAndResponses).join('\n');

		// Create Opik trace
		const trace = opikClient.trace({
			name: 'movie-recommendation-request',
			input: {
				numberOfPeople,
				availableRunTime,
				userResponses: allParticipantsResponses,
				peopleResponsesCount: peopleResponses.length,
			},
			tags: ['production', `people-${numberOfPeople}`, `runtime-${availableRunTime}`],
		});

		// Track metadata for cost/duration
		let totalCost = 0;
		let totalTokens = 0;

		let embedding;
		let matchedResults;

		// ===== EMBEDDING SPAN =====
		const embeddingSpan = trace.span({
			name: 'generate-embedding',
			type: 'general',
			input: {
				text: `${availableRunTime}\n${allParticipantsResponses}`,
				model: 'text-embedding-3-small',
				inputLength: `${availableRunTime}\n${allParticipantsResponses}`.length,
			},
		});

		try {
			const embeddingResponse = await openai.embeddings.create({
				model: 'text-embedding-3-small',
				input: `${availableRunTime}\n${allParticipantsResponses}`,
				encoding_format: 'float',
			});
			embedding = embeddingResponse.data[0].embedding;

			// Estimate tokens for embedding (roughly 1 token per 4 characters)
			const estimatedTokens = Math.ceil(`${availableRunTime}\n${allParticipantsResponses}`.length / 4);
			totalCost += calculateCost(estimatedTokens, 0, 'text-embedding-3-small');

			embeddingSpan.update({
				output: {
					dimensions: embedding.length,
				},
			});
			embeddingSpan.end();
		} catch (error: any) {
			console.error('Error creating embeddings for userResponses:', error);

			embeddingSpan.update({
				output: { error: error.message },
			});
			embeddingSpan.end();

			trace.update({
				output: { error: 'Error creating embeddings for userResponses' },
			});
			trace.end();

			await opikClient.flush();

			return new Response(JSON.stringify({ error: 'Error creating embeddings for userResponses', details: error.message }), {
				status: 500,
				headers: { ...allowedHeaders },
			});
		}

		// ===== VECTOR SEARCH SPAN =====
		const searchSpan = trace.span({
			name: 'vector-search',
			type: 'general',
			input: {
				threshold: 0.2,
				matchCount: 6,
				embeddingDimensions: embedding.length,
			},
		});

		try {
			matchedResults = await convex.action(api.movies.searchMovies, {
				embedding: embedding,
				matchThreshold: 0.2, // low threshold for more matches
				matchCount: 6, // up the matches as per stretch goals
			});

			searchSpan.update({
				output: {
					resultsCount: matchedResults.length,
					topScore: calculateTopScore(matchedResults),
					avgScore: calculateAverageScore(matchedResults),
					minScore: calculateMinScore(matchedResults),
				},
			});
			searchSpan.end();
		} catch (error: any) {
			console.error('Error matching documents in Convex:', error);

			searchSpan.update({
				output: { error: error.message },
			});
			searchSpan.end();

			trace.update({
				output: { error: 'Error matching documents in Convex' },
			});
			trace.end();

			await opikClient.flush();

			return new Response(JSON.stringify({ error: 'Error matching documents in Convex', details: error.message }), {
				status: 500,
				headers: { ...allowedHeaders },
			});
		}

		const movieRecommendationsResultsString = matchedResults
			.map((movie: { id: string; content: string; score: number }) => movie.content)
			.filter((content: string | null) => content) // Remove any empty/null values
			.join('\n\n'); // Join multiple movies with double line breaks

		const chatMessages = [
			{
				role: 'system',
				content: `You are an expert movie buff and a recommendation buddy who enjoys helping people find movies that match their preferences. 

				There are ${numberOfPeople} people in the group who have provided their responses to the questions about movies.
			  You will be given 4 questions from ${numberOfPeople} people. 
			  You will also be given 6 movie recommendations the most aligns to the preferences based on their answers.
			  Your main job is to formulate a short answer to the questions using the provided questions and answers.
			  Formulate 6 short paragraphs for each movie recommendation with more details about the movie. DO NOT SUGGEST MOVIES FROM THE RESPONSES. ONLY USE THE MOVIE RECOMMENDATIONS. 
			  If you are unsure and cannot find the users answers or have no movie recommendation or more details about the movie, say, "Sorry, I don't know a movie at the moment. Lets have another go with the questions from the previous section
			  ." Please do not make up the answer. Also dont repeat the users answers.


			  Here is the format of the response:
			  {
				"movieRecommendations": [
					{
						"title": "Movie Title",
						"releaseYear": "2024",
						"content": "Short paragraph about the movie ..."
					}
				]
			  }
			  `,
			},
			{
				role: 'user',
				content: `Questions and Answers from ${numberOfPeople} people: ${allParticipantsResponsesAndAnswers}\n Movie Recommendations: ${movieRecommendationsResultsString}`,
			},
		];
		// console.log('typeof matchedResults', typeof matchedResults);
		// console.log('matchedResults', matchedResults);
		// console.log(chatMessages);

		// ===== LLM SPAN =====
		const llmSpan = trace.span({
			name: 'llm-generation',
			type: 'llm',
			input: {
				model: 'gpt-4o-mini',
				temperature: 1.1,
				systemPromptLength: chatMessages[0].content.length,
				userPromptLength: chatMessages[1].content.length,
				movieContextLength: movieRecommendationsResultsString.length,
			},
		});

		try {
			const response = await openai.chat.completions.create({
				model: 'gpt-4o-mini',
				messages: chatMessages as OpenAI.Chat.ChatCompletionMessageParam[],
				temperature: 1.1,
			});

			totalTokens = response.usage?.total_tokens || 0;
			totalCost += calculateCost(
				response.usage?.prompt_tokens || 0,
				response.usage?.completion_tokens || 0,
				'gpt-4o-mini'
			);

			llmSpan.update({
				output: {
					responseLength: response.choices[0].message.content?.length || 0,
					promptTokens: response.usage?.prompt_tokens || 0,
					completionTokens: response.usage?.completion_tokens || 0,
					totalTokens: response.usage?.total_tokens || 0,
				},
				metadata: {
					usage: {
						promptTokens: response.usage?.prompt_tokens || 0,
						completionTokens: response.usage?.completion_tokens || 0,
						totalTokens: response.usage?.total_tokens || 0,
					},
				},
			});
			llmSpan.end();

			let responseObject: {
				content: string;
				movieRecommendations: typeof matchedResults | null;
				noMatchFromLLM: boolean;
			} = {
				content: '',
				movieRecommendations: null,
				noMatchFromLLM: false,
			};

			if (response.choices[0]?.message?.content?.includes("Sorry, I don't know a movie at the moment")) {
				responseObject.noMatchFromLLM = true;
			} else {
				responseObject.movieRecommendations = matchedResults;
				responseObject.content = response.choices[0].message.content || '';
			}

			// End trace with output and metadata
			trace.update({
				output: {
					movieRecommendations: responseObject.movieRecommendations,
					content: responseObject.content,
					noMatchFromLLM: responseObject.noMatchFromLLM,
				},
				metadata: {
					totalTokens,
					totalCost,
					success: true,
				},
			});
			trace.end();

			// Flush to ensure data is sent before response
			await opikClient.flush();

			return new Response(
				JSON.stringify({
					movieRecommendations: responseObject.movieRecommendations,
					content: responseObject.content || '',
					noMatchFromLLM: responseObject.noMatchFromLLM,
				}),
				{
					status: 200,
					headers: { ...allowedHeaders },
				}
			);
		} catch (error: any) {
			console.error('Error creating chat completion:', error);

			llmSpan.update({
				output: { error: error.message },
			});
			llmSpan.end();

			trace.update({
				output: { error: 'Error creating chat completion' },
				metadata: {
					totalTokens,
					totalCost,
					success: false,
					errorMessage: error.message,
				},
			});
			trace.end();

			await opikClient.flush();

			return new Response(JSON.stringify({ error: 'Error creating chat completion', details: error.message }), {
				status: 500,
				headers: { ...allowedHeaders },
			});
		}
	},
} satisfies ExportedHandler<Env>;
