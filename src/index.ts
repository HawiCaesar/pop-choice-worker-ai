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
		const allowedHeaders = corsHeaders(origin, env)

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
			peopleResponses: [{ userResponses: string; response: string }];
		};
		const movieSetUpPreferences = requestData.movieSetUpPreferences;
		const availableRunTime = movieSetUpPreferences.time;

		// TODO: to be used as a filter or weight
		//const numberOfPeople = movieSetUpPreferences.numberOfPeople;

		const peopleResponses = requestData.peopleResponses;
		const allParticipantsResponses = peopleResponses.map((person) => person.userResponses).join('\n');

		let embedding;
		let matchedResults;
		try {
			const embeddingResponse = await openai.embeddings.create({
				model: 'text-embedding-3-small',
				input: `${availableRunTime} ${allParticipantsResponses}`,
				encoding_format: 'float',
			});
			embedding = embeddingResponse.data[0].embedding;
			console.log(embedding);
		} catch (error: any) {
			console.error('Error creating embeddings for userResponses:', error);
			return new Response(JSON.stringify({ error: 'Error creating embeddings for userResponses', details: error.message }), {
				status: 500,
				headers: { ...allowedHeaders },
			});
		}

		try {
			const { error, data: matchedVectorStoreResults } = await supabase.rpc('match_popchoice', {
				query_embedding: embedding,
				match_threshold: 0.02, // low threshold for more matches
				match_count: 4, // up the matches as per stretch goals
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

		const chatMessages = [
			{
				role: 'system',
				content: `You are an expert movie buff and a recommendation buddy who enjoys helping people find movies that match their preferences. 
			  You will be given 3 questions from the user and their answers. 
			  You will also be given a movie the most aligns to their preference based on their answers.
			  Your main job is to formulate a short answer to the questios using the provided questions and answers and the movie recommendation and more details about the movie. 
			  If you are unsure and cannot find the users answers or have no movie recommendation or more details about the movie, say, "Sorry, I don't know a movie at the moment. Lets have another go with the questions from the previous section
			  ." Please do not make up the answer. Also dont repeat the users answers.
			  `,
			},
			{
				role: 'user',
				content: `Questions and Answers: ${questionsAndAnswersString}\n Movie Recommendation: ${matchedResults[0]?.title} ${matchedResults[0]?.releaseyear} ${matchedResults[0]?.content}`,
			},
		];
		console.log(chatMessages);

		try {
			const response = await openai.chat.completions.create({
				model: 'gpt-4o-mini',
				messages: chatMessages as OpenAI.Chat.ChatCompletionMessageParam[],
				temperature: 1.1,
			});

			let responseObject = {
				title: '',
				releaseYear: '',
				content: '',
				noMatchFromLLM: false,
			};

			if (response.choices[0]?.message?.content?.includes("Sorry, I don't know a movie at the moment")) {
				responseObject.noMatchFromLLM = true;
			} else {
				responseObject.title = matchedResults[0].title || '';
				responseObject.releaseYear = matchedResults[0].releaseyear || '';
				responseObject.content = response.choices[0].message.content || '';
			}

			return new Response(
				JSON.stringify({
					title: responseObject.title || '',
					releaseYear: responseObject.releaseYear || '',
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
