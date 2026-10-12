# Giving the model a role with a system prompt

When you use a model, you can dramatically improve its performance by using the system prompt to give it a role. This technique, known as role prompting, is the most powerful way to use system prompts.

## Why use role prompting?

- **Enhanced accuracy:** in complex scenarios like legal analysis or financial modeling, role prompting can significantly boost performance.
- **Tailored tone:** whether you need a CFO's brevity or a copywriter's flair, role prompting adjusts communication style.
- **Improved focus:** by setting the role context, the model stays more within the bounds of your task's specific requirements.

## How to give the model a role

Use the `system` parameter to set the role:

```python
response = client.messages.create(
    model="example-model",
    max_tokens=2048,
    system="You are a seasoned data scientist at a Fortune 500 company.",
    messages=[{"role": "user", "content": "Analyze this dataset for anomalies: <dataset>{{DATASET}}</dataset>"}],
)
```

Role prompting tip: experiment with roles. A data scientist might see different insights than a marketing strategist for the same data.

## Example: legal contract analysis

Without a role, the model might miss critical issues. With the system prompt "You are the General Counsel of a Fortune 500 tech company", it catches indemnification gaps and liability caps that a generic answer glosses over.

Put task-specific instructions in the user turn, and keep the system prompt for the role itself.
