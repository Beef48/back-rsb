import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fetch from 'node-fetch';
import pg from 'pg';

// PostgreSQL config
const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL est requis pour se connecter a Neon PostgreSQL');
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const PERSON_COLUMNS = new Set([
  'id',
  'person_name',
  'raw_data',
  'user_id',
  'age',
  'start_time',
  'end_time',
  'pathologie',
  'commentaire'
]);

function quoteIdentifier(identifier) {
  if (!PERSON_COLUMNS.has(identifier)) {
    throw new Error(`Colonne non autorisee: ${identifier}`);
  }
  return `"${identifier}"`;
}

function parseColumns(columns) {
  if (columns === '*') return '*';
  return columns.split(',').map(column => quoteIdentifier(column.trim())).join(', ');
}

async function getPersons({ columns = '*', where = '', params = [], limit } = {}) {
  const selectedColumns = parseColumns(columns);
  const limitClause = typeof limit === 'number' ? ` LIMIT ${limit}` : '';
  const { rows } = await pool.query(`SELECT ${selectedColumns} FROM persons${where}${limitClause}`, params);
  return rows;
}

async function insertPersons(persons) {
  if (!persons.length) return [];

  const columns = ['person_name', 'raw_data', 'user_id', 'age', 'start_time', 'end_time'];
  const values = [];
  const placeholders = persons.map((person, personIndex) => {
    const rowPlaceholders = columns.map((column, columnIndex) => {
      values.push(person[column] ?? null);
      return `$${personIndex * columns.length + columnIndex + 1}`;
    });
    return `(${rowPlaceholders.join(', ')})`;
  });

  const sql = `
    INSERT INTO persons (${columns.map(quoteIdentifier).join(', ')})
    VALUES ${placeholders.join(', ')}
    RETURNING *
  `;
  const { rows } = await pool.query(sql, values);
  return rows;
}

async function updatePersonById(id, updateData) {
  const entries = Object.entries(updateData);
  const setClause = entries.map(([column], index) => `${quoteIdentifier(column)} = $${index + 1}`).join(', ');
  const values = entries.map(([, value]) => value);
  values.push(id);

  const { rows } = await pool.query(
    `UPDATE persons SET ${setClause} WHERE id = $${values.length} RETURNING *`,
    values
  );
  return rows;
}

async function deletePersonById(id) {
  const { rows } = await pool.query('DELETE FROM persons WHERE id = $1 RETURNING *', [id]);
  return rows;
}

async function deletePersonsByIds(ids) {
  const { rows } = await pool.query('DELETE FROM persons WHERE id = ANY($1::uuid[]) RETURNING *', [ids]);
  return rows;
}

const fastify = Fastify({ logger: true });

// Fonction utilitaire pour interpoler des données sur une grille commune
function interpolateArray(xValues, yValues, newXValues) {
  if (!xValues || !yValues || xValues.length === 0 || yValues.length === 0) {
    return newXValues.map(() => NaN);
  }
  
  return newXValues.map(newX => {
    // Trouver les deux points les plus proches
    let leftIndex = -1;
    let rightIndex = -1;
    
    for (let i = 0; i < xValues.length; i++) {
      if (xValues[i] <= newX) {
        leftIndex = i;
      } else {
        rightIndex = i;
        break;
      }
    }
    
    // Si on est en dehors de la plage
    if (leftIndex === -1) {
      return yValues[0];
    }
    if (rightIndex === -1) {
      return yValues[yValues.length - 1];
    }
    
    // Interpolation linéaire
    const x1 = xValues[leftIndex];
    const y1 = yValues[leftIndex];
    const x2 = xValues[rightIndex];
    const y2 = yValues[rightIndex];
    
    if (x2 === x1) return y1;
    
    return y1 + (y2 - y1) * (newX - x1) / (x2 - x1);
  });
}

// --- CORS ---
await fastify.register(fastifyCors, {
  origin: true // ou ['http://localhost:5173'] pour n'autoriser que le front
});

// ✅ Route ping
fastify.get('/', async () => {
  return { status: 'ok', message: 'API Neon PostgreSQL Fastify en ligne' };
});

// ✅ Route /persons
fastify.get('/persons', async (request, reply) => {
  try {
    const data = await getPersons({ limit: 100 });
    return reply.send(data);
  } catch (err) {
    request.log.error(err);
    return reply.status(500).send({ error: 'Erreur interne serveur', details: err.message });
  }
});

// ✅ Route /persons/:name
fastify.get('/persons/:name', async (request, reply) => {
  try {
    const { name } = request.params;
    const data = await getPersons({ where: ' WHERE person_name = $1', params: [name] });
    if (!data || data.length === 0) {
      return reply.status(404).send({ error: `Aucune personne trouvée avec le nom "${name}"` });
    }
    return reply.send(data);
  } catch (err) {
    request.log.error(err);
    return reply.status(500).send({ error: 'Erreur serveur', details: err.message });
  }
});

// ✅ Route /stats/words
fastify.get('/stats/words', async (request, reply) => {
  try {
    const data = await getPersons({ columns: 'raw_data' });

    const stats = {};

    for (const person of data) {
      const raw = person.raw_data;
      if (!raw) continue;

      const wordKeys = Object.keys(raw).filter(k => /^wordHist\/\d+\/word$/.test(k));
      for (const wordKey of wordKeys) {
        const index = wordKey.split('/')[1];
        const word = raw[wordKey]?.toLowerCase();
        const rsb = raw[`wordHist/${index}/rsb`];

        if (!word || typeof rsb !== 'number') continue;

        if (!stats[word]) stats[word] = { total: 0, success: 0 };
        stats[word].total++;
        if (rsb >= 0) stats[word].success++;
      }
    }

    const finalStats = Object.entries(stats)
      .map(([word, { total, success }]) => ({
        word,
        total,
        success,
        rate: Math.round((success / total) * 100)
      }))
      .sort((a, b) => b.total - a.total);

    return reply.send(finalStats);
  } catch (err) {
    request.log.error(err);
    return reply.status(500).send({ error: 'Erreur interne serveur', details: err.message });
  }
});

// ✅ Route /stats/errors
fastify.get('/stats/errors', async (request, reply) => {
  try {
    const data = await getPersons({ columns: 'raw_data' });

    const errors = {};

    for (const person of data) {
      const raw = person.raw_data;
      if (!raw) continue;

      const wordKeys = Object.keys(raw).filter(k => /^wordHist\/\d+\/word$/.test(k));
      for (const wordKey of wordKeys) {
        const index = wordKey.split('/')[1];
        const word = raw[wordKey]?.toLowerCase();
        const rsb = raw[`wordHist/${index}/rsb`];

        if (!word || typeof rsb !== 'number') continue;
        if (rsb < 0) {
          if (!errors[word]) errors[word] = 0;
          errors[word]++;
        }
      }
    }

    const errorList = Object.entries(errors)
      .map(([word, count]) => ({ word, errors: count }))
      .sort((a, b) => b.errors - a.errors);

    return reply.send(errorList);
  } catch (err) {
    request.log.error(err);
    return reply.status(500).send({ error: 'Erreur interne serveur', details: err.message });
  }
});

// ✅ Route /analyze/all - Analyser toutes les personnes
fastify.get('/analyze/all', async (request, reply) => {
  try {
    const data = await getPersons();

    const results = [];
    for (const person of data) {
      const raw = person.raw_data;
      if (!raw) continue;

      // Extraire les paramètres RSB
      const rsbStart = parseInt(raw.rsbStart || '0');
      const rsbEnd = parseInt(raw.rsbEnd || '-14');
      const rsbStep = parseInt(raw.rsbStep || '-2');
      const wordCount = parseInt(raw.wordCnt || '4');

      const nbLevels = Math.abs(Math.floor((rsbEnd - rsbStart) / rsbStep)) + 1;
      const rsbLevels = Array.from({ length: nbLevels }, (_, i) => rsbStart + i * rsbStep);

      const resultsByRSB = {};
      rsbLevels.forEach(r => {
        resultsByRSB[r] = { correct: 0, total: 0, times: [] };
      });

      let validWords = 0;
      const totalExpected = nbLevels * wordCount;

      // Traitement des mots
      for (let i = 0; i < totalExpected; i++) {
        const word = raw[`wordHist/${i}/word`];
        const response = raw[`wordHist/${i}/resp`];
        const rsb = parseFloat(raw[`wordHist/${i}/rsb`]);
        const startTime = parseFloat(raw[`wordHist/${i}/beginningOfSpeechTime`]);
        const endTime = parseFloat(raw[`wordHist/${i}/endOfSpeechTime`]);

        if (!word || !response || isNaN(rsb) || isNaN(startTime) || isNaN(endTime)) {
          continue;
        }

        const duration = endTime - startTime;
        if (duration < 100 || duration > 10000) {
          continue;
        }

        validWords++;

        if (!resultsByRSB[rsb]) {
          resultsByRSB[rsb] = { correct: 0, total: 0, times: [] };
        }

        const isCorrect = response.toLowerCase().includes(word.toLowerCase());
        if (isCorrect) {
          resultsByRSB[rsb].correct++;
        }
        resultsByRSB[rsb].total++;
        resultsByRSB[rsb].times.push(duration);
      }

      // Exclusion si trop peu de données valides
      if (validWords < 0.8 * totalExpected) {
        continue;
      }

      const rsbPoints = Object.keys(resultsByRSB).map(Number).sort((a, b) => a - b);
      const percentages = rsbPoints.map(r => {
        const { correct, total } = resultsByRSB[r];
        return total > 0 ? (100 * correct) / total : 0;
      });

      const averageTimes = rsbPoints.map(r => {
        const times = resultsByRSB[r].times;
        return times.length > 0 ? times.reduce((a, b) => a + b, 0) / times.length : 0;
      });

      // Calcul des statistiques pour les limites de confiance
      const meanPercentage = percentages.reduce((sum, p) => sum + p, 0) / percentages.length;
      const variance = percentages.reduce((sum, p) => sum + Math.pow(p - meanPercentage, 2), 0) / percentages.length;
      const standardDeviation = Math.sqrt(variance);
      
      const lowerLimit = Math.max(0, meanPercentage - standardDeviation);
      const upperLimit = Math.min(100, meanPercentage + standardDeviation);

      results.push({
        person_name: person.person_name,
        person_id: person.id,
        rsbPoints,
        percentages,
        averageTimes,
        rsbStart,
        rsbEnd,
        validWords,
        totalExpected,
        statistics: {
          mean: meanPercentage,
          standardDeviation,
          lowerLimit,
          upperLimit
        }
      });
    }

    // Calcul des statistiques globales point par point RSB
    const rsbGrid = Array.from({ length: 11 }, (_, i) => -14 + i * 2); // -14 à 6 par pas de 2
    
    // Interpolation des données pour chaque personne sur la grille commune
    const interpolatedData = results.map(personData => {
      const interpolatedPercentages = interpolateArray(personData.rsbPoints, personData.percentages, rsbGrid);
      return { percentages: interpolatedPercentages };
    });
    
    // Calcul des statistiques pour chaque point RSB
    const globalMeans = rsbGrid.map((_, i) => {
      const values = interpolatedData.map(d => d.percentages[i]).filter(v => !isNaN(v));
      return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
    });
    
    const globalStandardDeviations = rsbGrid.map((_, i) => {
      const values = interpolatedData.map(d => d.percentages[i]).filter(v => !isNaN(v));
      if (values.length <= 1) return 0;
      const mean = globalMeans[i];
      const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
      return Math.sqrt(variance);
    });
    
    const globalLowerLimits = rsbGrid.map((_, i) => {
      return Math.max(0, globalMeans[i] - globalStandardDeviations[i]);
    });
    
    const globalUpperLimits = rsbGrid.map((_, i) => {
      return Math.min(100, globalMeans[i] + globalStandardDeviations[i]);
    });

    return reply.send({
      persons: results,
      globalStatistics: {
        rsbGrid,
        means: globalMeans,
        standardDeviations: globalStandardDeviations,
        lowerLimits: globalLowerLimits,
        upperLimits: globalUpperLimits,
        totalPersons: results.length
      }
    });
  } catch (err) {
    request.log.error(err);
    return reply.status(500).send({ error: 'Erreur interne serveur', details: err.message });
  }
});

// ✅ Route /analyze/persons - Analyser des personnes spécifiques
fastify.post('/analyze/persons', async (request, reply) => {
  try {
    const { personNames } = request.body;
    
    if (!personNames || !Array.isArray(personNames)) {
      return reply.status(400).send({ error: 'personNames doit être un tableau' });
    }

    const results = [];
    
    for (const name of personNames) {
      const data = await getPersons({ where: ' WHERE person_name = $1', params: [name] });

      for (const person of data) {
        const raw = person.raw_data;
        if (!raw) continue;

        // Même logique de traitement que ci-dessus
        const rsbStart = parseInt(raw.rsbStart || '0');
        const rsbEnd = parseInt(raw.rsbEnd || '-14');
        const rsbStep = parseInt(raw.rsbStep || '-2');
        const wordCount = parseInt(raw.wordCnt || '4');

        const nbLevels = Math.abs(Math.floor((rsbEnd - rsbStart) / rsbStep)) + 1;
        const rsbLevels = Array.from({ length: nbLevels }, (_, i) => rsbStart + i * rsbStep);

        const resultsByRSB = {};
        rsbLevels.forEach(r => {
          resultsByRSB[r] = { correct: 0, total: 0, times: [] };
        });

        let validWords = 0;
        const totalExpected = nbLevels * wordCount;
        let wordTests = [];

        for (let i = 0; i < totalExpected; i++) {
          const word = raw[`wordHist/${i}/word`];
          const response = raw[`wordHist/${i}/resp`];
          const rsb = parseFloat(raw[`wordHist/${i}/rsb`]);
          const startTime = parseFloat(raw[`wordHist/${i}/beginningOfSpeechTime`]);
          const endTime = parseFloat(raw[`wordHist/${i}/endOfSpeechTime`]);

          if (!word || !response || isNaN(rsb) || isNaN(startTime) || isNaN(endTime)) {
            continue;
          }

          const duration = endTime - startTime;
          if (duration < 100 || duration > 10000) {
            continue;
          }

          validWords++;

          if (!resultsByRSB[rsb]) {
            resultsByRSB[rsb] = { correct: 0, total: 0, times: [] };
          }

          const isCorrect = response.toLowerCase().includes(word.toLowerCase());
          if (isCorrect) {
            resultsByRSB[rsb].correct++;
          }
          resultsByRSB[rsb].total++;
          resultsByRSB[rsb].times.push(duration);

          wordTests.push({
            target: word,
            response,
            isCorrect,
            rsb,
            duration
          });
        }

        if (validWords < 0.8 * totalExpected) {
          continue;
        }

        const rsbPoints = Object.keys(resultsByRSB).map(Number).sort((a, b) => a - b);
        const percentages = rsbPoints.map(r => {
          const { correct, total } = resultsByRSB[r];
          return total > 0 ? (100 * correct) / total : 0;
        });

        const averageTimes = rsbPoints.map(r => {
          const times = resultsByRSB[r].times;
          return times.length > 0 ? times.reduce((a, b) => a + b, 0) / times.length : 0;
        });

        // Calcul des statistiques pour les limites de confiance
        const meanPercentage = percentages.reduce((sum, p) => sum + p, 0) / percentages.length;
        const variance = percentages.reduce((sum, p) => sum + Math.pow(p - meanPercentage, 2), 0) / percentages.length;
        const standardDeviation = Math.sqrt(variance);
        
        const lowerLimit = Math.max(0, meanPercentage - standardDeviation);
        const upperLimit = Math.min(100, meanPercentage + standardDeviation);

        results.push({
          person_name: person.person_name,
          person_id: person.id,
          rsbPoints,
          percentages,
          averageTimes,
          rsbStart,
          rsbEnd,
          validWords,
          totalExpected,
          wordTests,
          statistics: {
            mean: meanPercentage,
            standardDeviation,
            lowerLimit,
            upperLimit
          }
        });
      }
    }

    // Calcul des statistiques globales sur TOUTES les personnes de la BDD
    let allPersons = [];
    try {
      allPersons = await getPersons();
    } catch (allError) {
      request.log.error(allError);
      return reply.send(results); // Retourner au moins les résultats demandés
    }

    const allResults = [];
    for (const person of allPersons) {
      const raw = person.raw_data;
      if (!raw) continue;

      // Même logique de traitement que ci-dessus
      const rsbStart = parseInt(raw.rsbStart || '0');
      const rsbEnd = parseInt(raw.rsbEnd || '-14');
      const rsbStep = parseInt(raw.rsbStep || '-2');
      const wordCount = parseInt(raw.wordCnt || '4');

      const nbLevels = Math.abs(Math.floor((rsbEnd - rsbStart) / rsbStep)) + 1;
      const rsbLevels = Array.from({ length: nbLevels }, (_, i) => rsbStart + i * rsbStep);

      const resultsByRSB = {};
      rsbLevels.forEach(r => {
        resultsByRSB[r] = { correct: 0, total: 0, times: [] };
      });

      let validWords = 0;
      const totalExpected = nbLevels * wordCount;

      for (let i = 0; i < totalExpected; i++) {
        const word = raw[`wordHist/${i}/word`];
        const response = raw[`wordHist/${i}/resp`];
        const rsb = parseFloat(raw[`wordHist/${i}/rsb`]);
        const startTime = parseFloat(raw[`wordHist/${i}/beginningOfSpeechTime`]);
        const endTime = parseFloat(raw[`wordHist/${i}/endOfSpeechTime`]);

        if (!word || !response || isNaN(rsb) || isNaN(startTime) || isNaN(endTime)) {
          continue;
        }

        const duration = endTime - startTime;
        if (duration < 100 || duration > 10000) {
          continue;
        }

        validWords++;

        if (!resultsByRSB[rsb]) {
          resultsByRSB[rsb] = { correct: 0, total: 0, times: [] };
        }

        const isCorrect = response.toLowerCase().includes(word.toLowerCase());
        if (isCorrect) {
          resultsByRSB[rsb].correct++;
        }
        resultsByRSB[rsb].total++;
        resultsByRSB[rsb].times.push(duration);
      }

      if (validWords < 0.8 * totalExpected) {
        continue;
      }

      const rsbPoints = Object.keys(resultsByRSB).map(Number).sort((a, b) => a - b);
      const percentages = rsbPoints.map(r => {
        const { correct, total } = resultsByRSB[r];
        return total > 0 ? (100 * correct) / total : 0;
      });

      allResults.push({
        person_name: person.person_name,
        rsbPoints,
        percentages
      });
    }

    // Calcul des statistiques globales point par point RSB
    const rsbGrid = Array.from({ length: 11 }, (_, i) => -14 + i * 2); // -14 à 6 par pas de 2
    
    // Interpolation des données pour chaque personne sur la grille commune
    const interpolatedData = allResults.map(personData => {
      const interpolatedPercentages = interpolateArray(personData.rsbPoints, personData.percentages, rsbGrid);
      return { percentages: interpolatedPercentages };
    });
    
    // Calcul des statistiques pour chaque point RSB
    const globalMeans = rsbGrid.map((_, i) => {
      const values = interpolatedData.map(d => d.percentages[i]).filter(v => !isNaN(v));
      return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
    });
    
    const globalStandardDeviations = rsbGrid.map((_, i) => {
      const values = interpolatedData.map(d => d.percentages[i]).filter(v => !isNaN(v));
      if (values.length <= 1) return 0;
      const mean = globalMeans[i];
      const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
      return Math.sqrt(variance);
    });
    
    const globalLowerLimits = rsbGrid.map((_, i) => {
      return Math.max(0, globalMeans[i] - globalStandardDeviations[i]);
    });
    
    const globalUpperLimits = rsbGrid.map((_, i) => {
      return Math.min(100, globalMeans[i] + globalStandardDeviations[i]);
    });

    return reply.send({
      selectedPersons: results,
      globalStatistics: {
        rsbGrid,
        means: globalMeans,
        standardDeviations: globalStandardDeviations,
        lowerLimits: globalLowerLimits,
        upperLimits: globalUpperLimits,
        totalPersons: allResults.length
      }
    });
  } catch (err) {
    request.log.error(err);
    return reply.status(500).send({ error: 'Erreur interne serveur', details: err.message });
  }
});

// ✅ Route /overview - Statistiques globales
fastify.get('/overview', async (request, reply) => {
  try {
    const data = await getPersons({ columns: 'age, start_time, end_time, raw_data' });

    if (!data || data.length === 0) {
      return reply.send({ total: 0 });
    }

    const ages = data.map(p => p.age).filter(age => typeof age === 'number');
    const avgAge = ages.length ? (ages.reduce((a, b) => a + b, 0) / ages.length) : 0;

    const rsbValues = [];
    let validWordCounts = [];

    for (const p of data) {
      const raw = p.raw_data;
      if (!raw) continue;

      const rsbStart = parseInt(raw.rsbStart || 0);
      const rsbEnd = parseInt(raw.rsbEnd || -14);
      rsbValues.push(rsbStart, rsbEnd);

      const wordCount = parseInt(raw.wordCnt || 4);
      const nbLevels = Math.abs(Math.floor((rsbEnd - rsbStart) / parseInt(raw.rsbStep || -2))) + 1;
      const totalExpected = nbLevels * wordCount;

      let valid = 0;
      for (let i = 0; i < totalExpected; i++) {
        const word = raw[`wordHist/${i}/word`];
        const response = raw[`wordHist/${i}/resp`];
        if (word && response) valid++;
      }
      if (totalExpected > 0) {
        validWordCounts.push(valid / totalExpected);
      }
    }

    const avgValidWordRate = validWordCounts.length
      ? 100 * validWordCounts.reduce((a, b) => a + b, 0) / validWordCounts.length
      : 0;

    const lastDate = data
      .map(p => new Date(p.end_time))
      .filter(d => d instanceof Date && !isNaN(d))
      .sort((a, b) => b - a)[0];

    return reply.send({
      total_users: data.length,
      average_age: parseFloat(avgAge.toFixed(1)),
      rsb_range: {
        min: rsbValues.length ? Math.min(...rsbValues) : null,
        max: rsbValues.length ? Math.max(...rsbValues) : null
      },
      average_valid_word_rate: parseFloat(avgValidWordRate.toFixed(1)),
      last_test_date: lastDate?.toISOString() || null
    });
  } catch (err) {
    request.log.error(err);
    return reply.status(500).send({ error: 'Erreur serveur', details: err.message });
  }
});

// ✅ Route /import - Importer des personnes avec extraction automatique des données
fastify.post('/import', async (request, reply) => {
  try {
    let persons = request.body;
    if (!Array.isArray(persons)) {
      persons = [persons];
    }

    const processedPersons = [];

    for (const p of persons) {
      if (!p.person_name || !p.raw_data) {
        return reply.status(400).send({ error: 'Chaque entrée doit contenir person_name et raw_data' });
      }

      const raw = p.raw_data;
      
      // Debug: afficher toutes les clés disponibles dans raw_data
      console.log('=== DEBUG: Clés disponibles dans raw_data ===');
      console.log('Person:', p.person_name);
      console.log('Clés:', Object.keys(raw));
      console.log('Valeurs d\'âge possibles:');
      console.log('- raw.age:', raw.age);
      console.log('- raw.age_participant:', raw.age_participant);
      console.log('- raw.participant_age:', raw.participant_age);
      console.log('- raw.userAge:', raw.userAge);
      console.log('==========================================');
      
      // Extraction des données depuis raw_data
      const extractedData = {
        person_name: p.person_name,
        raw_data: raw,
        // Extraction des champs de base
        user_id: raw.userId || raw.user_id || raw.userID || null,
        age: raw.userAge ? parseInt(raw.userAge) :
             raw.age ? parseInt(raw.age) : 
             raw.age_participant ? parseInt(raw.age_participant) :
             raw.participant_age ? parseInt(raw.participant_age) :
             null,
        
        // Extraction des timestamps
        start_time: raw.start_time || raw.startTime || raw.beginningTime || 
                   (raw.startDate ? new Date(raw.startDate).toISOString() : null),
        end_time: raw.end_time || raw.endTime || raw.finishTime || 
                 (raw.endDate ? new Date(raw.endDate).toISOString() : null)
      };



      // Si pas de start_time/end_time dans raw_data, essayer de les calculer depuis les timestamps des mots
      if (!extractedData.start_time || !extractedData.end_time) {
        const timestamps = [];
        for (let i = 0; i < 100; i++) { // Limite pour éviter une boucle infinie
          const startTime = raw[`wordHist/${i}/beginningOfSpeechTime`];
          const endTime = raw[`wordHist/${i}/endOfSpeechTime`];
          if (startTime && !isNaN(startTime)) timestamps.push(parseFloat(startTime));
          if (endTime && !isNaN(endTime)) timestamps.push(parseFloat(endTime));
        }
        
        if (timestamps.length > 0) {
          const minTime = Math.min(...timestamps);
          const maxTime = Math.max(...timestamps);
          
          if (!extractedData.start_time) {
            extractedData.start_time = new Date(minTime).toISOString();
          }
          if (!extractedData.end_time) {
            extractedData.end_time = new Date(maxTime).toISOString();
          }
        }
      }

      // Si pas de user_id, utiliser le person_name en minuscules
      if (!extractedData.user_id) {
        extractedData.user_id = p.person_name.toLowerCase();
      }

      processedPersons.push(extractedData);
    }

    // Insertion dans PostgreSQL
    await insertPersons(processedPersons);

    return reply.send({ 
      success: true, 
      count: processedPersons.length,
      message: `✅ ${processedPersons.length} participant(s) importé(s) avec succès !`,
      imported_persons: processedPersons.map(p => ({
        name: p.person_name,
        age: p.age,
        user_id: p.user_id
      })),
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    return reply.status(500).send({ error: err.message });
  }
});

// ✅ Route PUT /persons/:id/reference - Mettre à jour pathologie et commentaire
fastify.put('/persons/:id/reference', async (request, reply) => {
  try {
    const { id } = request.params;
    const { pathologie, commentaire } = request.body;

    // Validation des données
    if (!id) {
      return reply.status(400).send({ error: 'ID de la personne requis' });
    }

    // Préparer les données à mettre à jour
    const updateData = {};
    if (pathologie !== undefined) updateData.pathologie = pathologie;
    if (commentaire !== undefined) updateData.commentaire = commentaire;

    if (Object.keys(updateData).length === 0) {
      return reply.status(400).send({ error: 'Aucune donnée à mettre à jour (pathologie ou commentaire)' });
    }

    // Mettre à jour dans PostgreSQL
    const data = await updatePersonById(id, updateData);

    if (!data || data.length === 0) {
      return reply.status(404).send({ error: 'Personne non trouvée' });
    }

    return reply.send({
      message: 'Référentiel mis à jour avec succès',
      person: data[0]
    });
  } catch (err) {
    request.log.error(err);
    return reply.status(500).send({ error: 'Erreur serveur', details: err.message });
  }
});

// ✅ Route GET /persons/with-reference - Récupérer toutes les personnes avec pathologie et commentaire
fastify.get('/persons/with-reference', async (request, reply) => {
  try {
    const data = await getPersons({ columns: 'id, person_name, age, pathologie, commentaire', limit: 100 });

    return reply.send(data || []);
  } catch (err) {
    request.log.error(err);
    return reply.status(500).send({ error: 'Erreur serveur', details: err.message });
  }
});

// ✅ Route PATCH /persons/:id - Mettre à jour nom, âge, pathologie, commentaire
fastify.patch('/persons/:id', async (request, reply) => {
  try {
    const { id } = request.params;
    const { person_name, age, pathology, comment, pathologie, commentaire } = request.body || {};

    if (!id) {
      return reply.status(400).send({ error: 'ID requis' });
    }

    const updateData = {};
    if (typeof person_name === 'string') updateData.person_name = person_name;
    if (typeof age === 'number') updateData.age = age;
    // Mapper champs front/back
    const finalPathologie = pathology ?? pathologie;
    const finalCommentaire = comment ?? commentaire;
    if (finalPathologie !== undefined) updateData.pathologie = finalPathologie;
    if (finalCommentaire !== undefined) updateData.commentaire = finalCommentaire;

    if (Object.keys(updateData).length === 0) {
      return reply.status(400).send({ error: 'Aucune donnée à mettre à jour' });
    }

    const data = await updatePersonById(id, updateData);

    if (!data || data.length === 0) {
      return reply.status(404).send({ error: 'Personne non trouvée' });
    }

    return reply.send(data[0]);
  } catch (err) {
    request.log.error(err);
    return reply.status(500).send({ error: 'Erreur serveur', details: err.message });
  }
});

// ✅ Route DELETE /persons/:id - Supprimer une personne
fastify.delete('/persons/:id', async (request, reply) => {
  try {
    const { id } = request.params;

    if (!id) {
      return reply.status(400).send({ error: 'ID de la personne requis' });
    }

    // Supprimer de PostgreSQL
    const data = await deletePersonById(id);

    if (!data || data.length === 0) {
      return reply.status(404).send({ error: 'Personne non trouvée' });
    }

    return reply.send({
      message: 'Personne supprimée avec succès',
      deleted_person: data[0]
    });
  } catch (err) {
    request.log.error(err);
    return reply.status(500).send({ error: 'Erreur serveur', details: err.message });
  }
});

// ✅ Route DELETE /persons - Supprimer plusieurs personnes (par IDs)
fastify.delete('/persons', async (request, reply) => {
  try {
    const { ids } = request.body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return reply.status(400).send({ error: 'Liste d\'IDs requise (tableau non vide)' });
    }

    // Supprimer de PostgreSQL
    const data = await deletePersonsByIds(ids);

    return reply.send({
      message: `${data?.length || 0} personne(s) supprimée(s) avec succès`,
      deleted_count: data?.length || 0,
      deleted_persons: data || []
    });
  } catch (err) {
    request.log.error(err);
    return reply.status(500).send({ error: 'Erreur serveur', details: err.message });
  }
});

//  Lancement serveur
fastify.listen({ port: 3100 }, (err, address) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
  console.log(`✅ Serveur Fastify lancé sur ${address}`);
});

