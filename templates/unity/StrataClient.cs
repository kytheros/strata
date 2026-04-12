// StrataClient.cs — Unity helper for Strata's REST API
// See specs/2026-04-11-per-player-npc-scoping-design.md

using System;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Threading.Tasks;
using UnityEngine;

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

/// <summary>
/// Thin HTTP client for Strata's REST API. Supports both no-auth mode
/// (construct with empty bearerToken) and player-token mode (construct
/// with a token returned by <see cref="ProvisionPlayer"/>).
/// </summary>
public class StrataClient
{
    private readonly HttpClient _http;
    private readonly string _baseUrl;
    private readonly string _bearerToken;

    public StrataClient(string baseUrl, string bearerToken, int timeoutSeconds = 30)
    {
        _baseUrl = baseUrl.TrimEnd('/');
        _bearerToken = bearerToken ?? "";
        _http = new HttpClient { Timeout = TimeSpan.FromSeconds(timeoutSeconds) };
        _http.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        if (!string.IsNullOrEmpty(_bearerToken))
        {
            _http.DefaultRequestHeaders.Authorization =
                new AuthenticationHeaderValue("Bearer", _bearerToken);
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

    public async Task<string> Store(string agentId, string memory, string type = "fact", string[] tags = null)
    {
        var req = new StoreRequest { memory = memory, type = type, tags = tags ?? new string[0] };
        return await PostJson($"/api/agents/{agentId}/store", JsonUtility.ToJson(req));
    }

    public async Task<string> Search(string agentId, string query, int limit = 20)
    {
        var req = new SearchRequest { query = query, limit = limit };
        return await PostJson($"/api/agents/{agentId}/search", JsonUtility.ToJson(req));
    }

    public async Task<string> Recall(string agentId, string situation, int limit = 10)
    {
        var req = new RecallRequest { situation = situation, limit = limit };
        return await PostJson($"/api/agents/{agentId}/recall", JsonUtility.ToJson(req));
    }

    public async Task<string> Ingest(string agentId, string title, string content, string[] tags = null)
    {
        var req = new IngestRequest { title = title, content = content, tags = tags ?? new string[0] };
        return await PostJson($"/api/agents/{agentId}/ingest", JsonUtility.ToJson(req));
    }

    public async Task<string> Profile(string agentId)
    {
        var response = await _http.GetAsync(_baseUrl + $"/api/agents/{agentId}/profile");
        return await response.Content.ReadAsStringAsync();
    }

    public async Task<string> DeleteMemory(string agentId, string memoryId)
    {
        var response = await _http.DeleteAsync(_baseUrl + $"/api/agents/{agentId}/memory/{memoryId}");
        return await response.Content.ReadAsStringAsync();
    }

    public async Task<string> Training(string agentId, string input, string output, string model = null, float quality = 0.8f)
    {
        var req = new TrainingRequest { input = input, output = output, model = model ?? "unknown", quality = quality };
        return await PostJson($"/api/agents/{agentId}/training", JsonUtility.ToJson(req));
    }

    private async Task<string> PostJson(string path, string json)
    {
        var content = new StringContent(json, Encoding.UTF8, "application/json");
        var response = await _http.PostAsync(_baseUrl + path, content);
        var respText = await response.Content.ReadAsStringAsync();
        if (!response.IsSuccessStatusCode)
        {
            Debug.LogWarning($"[Strata] {path} returned {(int)response.StatusCode}: {respText}");
        }
        return respText;
    }
}
