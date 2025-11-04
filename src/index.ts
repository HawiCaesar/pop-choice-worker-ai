import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';

function corsHeaders(origin: string | null, env): Record<string, string> {
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

const getAllowedOrigins = (env): string[] => {
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

		const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_API_KEY);

		const requestData = (await request.json()) as {
			movieSetUpPreferences: { stringifiedQueryAndResponsesForInitialSetUp: string; numberOfPeople: string; time: string };
			peopleResponses: [{ userResponses: string; stringifiedQueryAndResponses: string }];
		};
		const movieSetUpPreferences = requestData.movieSetUpPreferences;
		const availableRunTime = movieSetUpPreferences.time;

		const numberOfPeople = movieSetUpPreferences.numberOfPeople;

		const peopleResponses = requestData.peopleResponses;
		const allParticipantsResponses = peopleResponses.map((person) => person.userResponses).join('\n');
		const allParticipantsResponsesAndAnswers = peopleResponses.map((person) => person.stringifiedQueryAndResponses).join('\n');

		let embedding;
		let matchedResults;
		try {
			const embeddingResponse = await openai.embeddings.create({
				model: 'text-embedding-3-small',
				input: `${availableRunTime}\n${allParticipantsResponses}`,
				encoding_format: 'float',
			});
			embedding = embeddingResponse.data[0].embedding;
		} catch (error: any) {
			console.error('Error creating embeddings for userResponses:', error);
			return new Response(JSON.stringify({ error: 'Error creating embeddings for userResponses', details: error.message }), {
				status: 500,
				headers: { ...allowedHeaders },
			});
		}

		try {
			const { error, data: matchedVectorStoreResults } = await supabase.rpc('match_popchoice_unstructured', {
				query_embedding: embedding,
				match_threshold: 0.2, // low threshold for more matches, was 0.02
				match_count: 6, // up the matches as per stretch goals
			});

			if (error) {
				console.error('Error matching documents in supabase:', error);
				return new Response(JSON.stringify({ error: 'Error matching documents in supabase', details: error.message }), {
					status: 500,
					headers: { ...allowedHeaders },
				});
			}
			matchedResults = matchedVectorStoreResults;
		} catch (error: any) {
			console.error('General error matching vector embeddings:', error);
			return new Response(JSON.stringify({ error: 'General error matching vector embeddings', details: error.message }), {
				status: 500,
				headers: { ...allowedHeaders },
			});
		}

		const movieRecommendationsResultsString = matchedResults
			.map((movie: {id: number; content: string }) => movie.content)
			.filter((content: string | null) => content) // Remove any empty/null values
			.join('\n\n'); // Join multiple movies with double line breaks

		const chatMessages = [
			{
				role: 'system',
				content: `You are an expert movie buff and a recommendation buddy who enjoys helping people find movies that match their preferences. 

				There are ${numberOfPeople} people in the group who have provided their responses to the questions about movies.
			  You will be given 4 questions from ${numberOfPeople} people. 
			  You will also be given 4 movie recommendations the most aligns to the preferences based on their answers.
			  Your main job is to formulate a short answer to the questions using the provided questions and answers.
			  Formulate 4 short paragraphs for each movie recommendation with more details about the movie. DO NOT SUGGEST MOVIES FROM THE RESPONSES. ONLY USE THE MOVIE RECOMMENDATIONS. 
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

		try {
			const response = await openai.chat.completions.create({
				model: 'gpt-4o-mini',
				messages: chatMessages as OpenAI.Chat.ChatCompletionMessageParam[],
				temperature: 1.1,
			});

			let responseObject = {
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
			return new Response(JSON.stringify({ error: 'Error creating chat completion', details: error.message }), {
				status: 500,
				headers: { ...allowedHeaders },
			});
		}
	},
} satisfies ExportedHandler<Env>;
