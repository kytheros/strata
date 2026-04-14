// StrataClient.cs — Unity helper for Strata REST API
// Uses [Serializable] request/response classes because Unity's JsonUtility cannot serialize anonymous objects.
// See specs/2026-04-11-per-player-npc-scoping-design.md

using System;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Threading.Tasks;
using UnityEngine;

// ── Request DTOs (JsonUtility requires [Serializable]) ──

[Serializable]
public class StoreRequest
{
    public string memory;
    public string type;
    public string[] tags;
}

[Serializable]
public class SearchRequest
{
    public string query;
    public int limit;
}

[Serializable]
public class RecallRequest
{
    public string situation;
    public int limit;
}

[Serializable]
public class IngestRequest
{
    public string title;
    public string content;
    public string[] tags;
}

[Serializable]
public class TrainingRequest
{
    public string input;
    public string output;
    public string model;
    public float quality;
}

[Serializable]
public class ProvisionPlayerRequest
{
    public string externalId;
}

[Serializable]
public class ProvisionPlayerResponse
{
    public string playerId;
    public string playerToken;
    public string externalId;
    public long createdAt;
    public bool isNew;
}

// ── Response DTOs ──

[Serializable]
public class StoreResult
{
    public string id;
    public bool stored;
}

[Serializable]
public class SearchResultItem
{
    public string id;
    public string text;
    public string type;
    public float confidence;
    public string source;
    public long timestamp;
    public string[] tags;
}

[Serializable]
public class SearchResponse
{
    public SearchResultItem[] results;
}

[Serializable]
public class RecallContextItem
{
    public string text;
    public string type;
    public float confidence;
    public string source;
}

[Serializable]
public class RecallResult
{
    public RecallContextItem[] context;
    public string summary;
}

[Serializable]
public class IngestResult
{
    public string document_id;
    public int chunks;
    public bool indexed;
}

[Serializable]
public class TrainingResult
{
    public bool stored;
    public string task_type;
    public int total_pairs;
}

[Serializable]
public class ProfileResult
{
    public string agent_id;
    public int memory_count;
    public long last_interaction;
}

[Serializable]
public class DeleteResult
{
    public bool deleted;
}

[Serializable]
public class NpcAlignment
{
    public string ethical;
    public string moral;
}

[Serializable]
public class NpcProfileResult
{
    public string agent_id;
    public string name;
    public string title;
    public NpcAlignment alignment;
    public string faction;
    public string[] traits;
    public string backstory;
    public float defaultTrust;
    public int memory_count;
    public long last_interaction;
}

[Serializable]
public class CharacterCardResult
{
    public string playerId;
    public string displayName;
    public string[] factions;
    public string[] tags;
}

[Serializable]
public class CharacterCardRequest
{
    public string displayName;
    public string[] factions;
    public string[] tags;
}

[Serializable]
public class ObservationItem
{
    public string @event;
    public long timestamp;
    public string[] tags;
    public TrustDelta delta;
    public string source;
}

[Serializable]
public class TrustDelta
{
    public float trust;
}

[Serializable]
public class RelationshipResult
{
    public float trust;
    public int familiarity;
    public string disposition;
    public ObservationItem[] observations;
    public AnchorState anchor;    // null if no anchor
}

[Serializable]
public class ObserveRequest
{
    public string @event;
    public string[] tags;
}

[Serializable]
public class ObserveResult
{
    public float trust;
    public string disposition;
    public TrustDelta delta;
}

[Serializable]
public class AnchorState
{
    public string state;        // "friend" | "rival"
    public float depth;
    public float anchorTrust;
    public long since;
}

[Serializable]
public class SetAnchorRequest
{
    public string state;
    public float depth;
}

/// <summary>
/// Typed HTTP client for Strata's REST API. Supports both no-auth mode
/// (construct with empty token) and player-token mode (construct
/// with a token returned by <see cref="ProvisionPlayer"/>).
/// All data methods return null on failure (never throw).
/// </summary>
public class StrataClient
{
    private readonly HttpClient _http;
    private readonly string _baseUrl;

    public StrataClient(string baseUrl = "http://localhost:3001", string token = null, int timeoutSeconds = 15)
    {
        _baseUrl = baseUrl.TrimEnd('/');
        _http = new HttpClient { Timeout = TimeSpan.FromSeconds(timeoutSeconds) };
        _http.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        if (!string.IsNullOrEmpty(token))
        {
            _http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        }
    }

    /// <summary>
    /// Provision a new player (or retrieve an existing one by externalId)
    /// using the admin token. Returns the raw player token — store it in
    /// PlayerPrefs and use it for the client's bearer token going forward.
    /// </summary>
    public static async Task<string> ProvisionPlayer(
        string baseUrl, string adminToken, string externalId = null, int timeoutSeconds = 30)
    {
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(timeoutSeconds) };
        http.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Bearer", adminToken);

        var req = new ProvisionPlayerRequest { externalId = externalId };
        var body = JsonUtility.ToJson(req);
        var content = new StringContent(body, Encoding.UTF8, "application/json");
        var response = await http.PostAsync(baseUrl.TrimEnd('/') + "/api/players", content);
        if (!response.IsSuccessStatusCode)
        {
            var err = await response.Content.ReadAsStringAsync();
            throw new Exception($"ProvisionPlayer failed ({(int)response.StatusCode}): {err}");
        }
        var respJson = await response.Content.ReadAsStringAsync();
        var parsed = JsonUtility.FromJson<ProvisionPlayerResponse>(respJson);
        if (parsed == null || string.IsNullOrEmpty(parsed.playerToken))
        {
            throw new Exception("ProvisionPlayer: missing playerToken in response");
        }
        return parsed.playerToken;
    }

    public async Task<StoreResult> StoreMemory(string agentId, string memory, string type = "fact", string[] tags = null)
    {
        var req = new StoreRequest { memory = memory, type = type, tags = tags ?? Array.Empty<string>() };
        return await Post<StoreResult>($"/api/agents/{agentId}/store", req);
    }

    public async Task<SearchResultItem[]> Search(string agentId, string query, int limit = 5)
    {
        var req = new SearchRequest { query = query, limit = limit };
        var response = await Post<SearchResponse>($"/api/agents/{agentId}/search", req);
        return response?.results ?? Array.Empty<SearchResultItem>();
    }

    public async Task<RecallResult> Recall(string agentId, string situation, int limit = 10)
    {
        var req = new RecallRequest { situation = situation, limit = limit };
        return await Post<RecallResult>($"/api/agents/{agentId}/recall", req);
    }

    public async Task<IngestResult> IngestLore(string agentId, string title, string content, string[] tags = null)
    {
        var req = new IngestRequest { title = title, content = content, tags = tags ?? Array.Empty<string>() };
        return await Post<IngestResult>($"/api/agents/{agentId}/ingest", req);
    }

    public async Task<TrainingResult> CaptureTraining(string agentId, string input, string output, string model, float quality = 0.8f)
    {
        var req = new TrainingRequest { input = input, output = output, model = model, quality = quality };
        return await Post<TrainingResult>($"/api/agents/{agentId}/training", req);
    }

    public async Task<bool> DeleteMemory(string agentId, string memoryId)
    {
        var result = await Delete<DeleteResult>($"/api/agents/{agentId}/memory/{memoryId}");
        return result?.deleted ?? false;
    }

    public async Task<NpcProfileResult> GetProfile(string agentId)
    {
        return await Get<NpcProfileResult>($"/api/agents/{agentId}/profile");
    }

    public async Task<RelationshipResult> GetRelationship(string agentId)
    {
        return await Get<RelationshipResult>($"/api/agents/{agentId}/relationship");
    }

    public async Task<ObserveResult> Observe(string agentId, string eventName, string[] tags)
    {
        var req = new ObserveRequest { @event = eventName, tags = tags ?? Array.Empty<string>() };
        return await Post<ObserveResult>($"/api/agents/{agentId}/relationship/observe", req);
    }

    public async Task<RelationshipResult> SetAnchor(string agentId, string state, float depth)
    {
        var req = new SetAnchorRequest { state = state, depth = depth };
        return await Put<RelationshipResult>($"/api/agents/{agentId}/anchor", req);
    }

    public async Task<CharacterCardResult> GetCharacter(string playerId)
    {
        return await Get<CharacterCardResult>($"/api/players/{playerId}/character");
    }

    public async Task SetCharacter(string playerId, string displayName, string[] factions, string[] tags)
    {
        var req = new CharacterCardRequest
        {
            displayName = displayName,
            factions = factions ?? Array.Empty<string>(),
            tags = tags ?? Array.Empty<string>(),
        };
        await Post<CharacterCardResult>($"/api/players/{playerId}/character", req);
    }

    // ── HTTP helpers (never throw — return null on failure) ──

    private async Task<T> Post<T>(string path, object body) where T : class
    {
        try
        {
            var json = JsonUtility.ToJson(body);
            var content = new StringContent(json, Encoding.UTF8, "application/json");
            var response = await _http.PostAsync(_baseUrl + path, content);
            if (!response.IsSuccessStatusCode)
            {
                Debug.LogWarning($"[Strata] POST {path} returned {(int)response.StatusCode}");
                return null;
            }
            var responseJson = await response.Content.ReadAsStringAsync();
            return JsonUtility.FromJson<T>(responseJson);
        }
        catch (Exception ex)
        {
            Debug.LogWarning($"[Strata] POST {path} failed: {ex.Message}");
            return null;
        }
    }

    private async Task<T> Get<T>(string path) where T : class
    {
        try
        {
            var response = await _http.GetAsync(_baseUrl + path);
            if (!response.IsSuccessStatusCode) return null;
            var json = await response.Content.ReadAsStringAsync();
            return JsonUtility.FromJson<T>(json);
        }
        catch (Exception ex)
        {
            Debug.LogWarning($"[Strata] GET {path} failed: {ex.Message}");
            return null;
        }
    }

    private async Task<T> Delete<T>(string path) where T : class
    {
        try
        {
            var response = await _http.DeleteAsync(_baseUrl + path);
            if (!response.IsSuccessStatusCode) return null;
            var json = await response.Content.ReadAsStringAsync();
            return JsonUtility.FromJson<T>(json);
        }
        catch (Exception ex)
        {
            Debug.LogWarning($"[Strata] DELETE {path} failed: {ex.Message}");
            return null;
        }
    }

    private async Task<T> Put<T>(string path, object body) where T : class
    {
        try
        {
            var json = JsonUtility.ToJson(body);
            var content = new StringContent(json, Encoding.UTF8, "application/json");
            var response = await _http.PutAsync(_baseUrl + path, content);
            if (!response.IsSuccessStatusCode)
            {
                Debug.LogWarning($"[Strata] PUT {path} returned {(int)response.StatusCode}");
                return null;
            }
            var responseJson = await response.Content.ReadAsStringAsync();
            return JsonUtility.FromJson<T>(responseJson);
        }
        catch (Exception ex)
        {
            Debug.LogWarning($"[Strata] PUT {path} failed: {ex.Message}");
            return null;
        }
    }
}
