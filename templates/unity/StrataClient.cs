// StrataClient.cs — Unity helper for Strata REST API
// Drop this file into your Unity project's Assets/Scripts/ folder.
// Requires Unity 6+ (or any version with System.Net.Http support).
//
// Usage:
//   var strata = new StrataClient("http://localhost:3001", "your-token");
//   var memories = await strata.Search("npc-blacksmith", "what about the player");
//   await strata.StoreMemory("npc-blacksmith", "Player bought a sword", "episodic");

using System;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Threading.Tasks;
using UnityEngine;

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

public class StrataClient
{
    private readonly HttpClient _http;
    private readonly string _baseUrl;

    /// <summary>
    /// Create a new Strata client.
    /// </summary>
    /// <param name="baseUrl">Strata REST API URL (default: http://localhost:3001)</param>
    /// <param name="token">Bearer token for auth (null for local dev without auth)</param>
    /// <param name="timeoutSeconds">HTTP timeout in seconds (default: 10)</param>
    public StrataClient(string baseUrl = "http://localhost:3001", string token = null, int timeoutSeconds = 10)
    {
        _baseUrl = baseUrl.TrimEnd('/');
        _http = new HttpClient { Timeout = TimeSpan.FromSeconds(timeoutSeconds) };
        _http.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        if (!string.IsNullOrEmpty(token))
        {
            _http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        }
    }

    /// <summary>Store a memory for an NPC/agent.</summary>
    public async Task<StoreResult> StoreMemory(string agentId, string memory, string type = "fact", string[] tags = null)
    {
        var body = new { memory, type, tags = tags ?? Array.Empty<string>() };
        return await Post<StoreResult>($"/api/agents/{agentId}/store", body);
    }

    /// <summary>Search an NPC's memories.</summary>
    public async Task<SearchResultItem[]> Search(string agentId, string query, int limit = 5)
    {
        var response = await Post<SearchResponse>($"/api/agents/{agentId}/search", new { query, limit });
        return response?.results ?? Array.Empty<SearchResultItem>();
    }

    /// <summary>Recall context for building an NPC dialogue prompt.</summary>
    public async Task<RecallResult> Recall(string agentId, string situation, int limit = 10)
    {
        return await Post<RecallResult>($"/api/agents/{agentId}/recall", new { situation, limit });
    }

    /// <summary>Ingest a lore document into an NPC's memory.</summary>
    public async Task<IngestResult> IngestLore(string agentId, string title, string content, string[] tags = null)
    {
        return await Post<IngestResult>($"/api/agents/{agentId}/ingest", new { title, content, tags = tags ?? Array.Empty<string>() });
    }

    /// <summary>Capture a dialogue training pair for distillation.</summary>
    public async Task<TrainingResult> CaptureTraining(string agentId, string input, string output, string model, float quality = 0.8f)
    {
        return await Post<TrainingResult>($"/api/agents/{agentId}/training", new { input, output, model, quality });
    }

    /// <summary>Delete a specific memory.</summary>
    public async Task<bool> DeleteMemory(string agentId, string memoryId)
    {
        var result = await Delete<DeleteResult>($"/api/agents/{agentId}/memory/{memoryId}");
        return result?.deleted ?? false;
    }

    /// <summary>Get an NPC's profile summary.</summary>
    public async Task<ProfileResult> GetProfile(string agentId)
    {
        return await Get<ProfileResult>($"/api/agents/{agentId}/profile");
    }

    // ── HTTP helpers (never throw — return null on failure) ──

    private async Task<T> Post<T>(string path, object body) where T : class
    {
        try
        {
            var json = JsonUtility.ToJson(body);
            var content = new StringContent(json, Encoding.UTF8, "application/json");
            var response = await _http.PostAsync(_baseUrl + path, content);
            if (!response.IsSuccessStatusCode) return null;
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
}
