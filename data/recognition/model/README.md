---
tags:
- sentence-transformers
- sentence-similarity
- feature-extraction
- dense
- generated_from_trainer
- dataset_size:11900
- loss:ContrastiveLoss
widget:
- source_sentence: Write a poem about the beauty of autumn leaves.
  sentences:
  - 'Planner. Owns decomposition, architecture, dependencies, sequencing, and coordination
    of multi-agent implementation work. Instructions: Turn broad work into coherent
    executable plans.'
  - 'Planner. Owns decomposition, architecture, dependencies, sequencing, and coordination
    of multi-agent implementation work. Instructions: Turn broad work into coherent
    executable plans.'
  - 'Calculator. Owns arithmetic, unit conversion, numerical estimation, percentages,
    and deterministic quantitative checks. Instructions: Compute carefully and show
    the relevant result.'
- source_sentence: Write a poem about the changing seasons.
  sentences:
  - 'Frontend Engineer. Owns React components, browser behavior, layout, accessibility,
    styling, responsive design, and user interaction. Instructions: Work on client-side
    UI and browser experience.'
  - 'Backend Engineer. Owns APIs, middleware, databases, authentication, persistence,
    server-side runtime behavior, and deployment. Instructions: Work on server-side
    implementation and integration.'
  - 'Frontend Engineer. Owns React components, browser behavior, layout, accessibility,
    styling, responsive design, and user interaction. Instructions: Work on client-side
    UI and browser experience.'
- source_sentence: Calculate the total cost of 15 items priced at $3.50 each.
  sentences:
  - 'Calculator. Owns arithmetic, unit conversion, numerical estimation, percentages,
    and deterministic quantitative checks. Instructions: Compute carefully and show
    the relevant result.'
  - 'Documentation Engineer. Owns README files, specifications, API documentation,
    examples, migration notes, and user-facing explanations. Instructions: Keep documentation
    accurate, concise, and usable.'
  - 'Calculator. Owns arithmetic, unit conversion, numerical estimation, percentages,
    and deterministic quantitative checks. Instructions: Compute carefully and show
    the relevant result.'
- source_sentence: Outline the integration steps for the new payment gateway.
  sentences:
  - 'Planner. Owns decomposition, architecture, dependencies, sequencing, and coordination
    of multi-agent implementation work. Instructions: Turn broad work into coherent
    executable plans.'
  - 'Calculator. Owns arithmetic, unit conversion, numerical estimation, percentages,
    and deterministic quantitative checks. Instructions: Compute carefully and show
    the relevant result.'
  - 'Calculator. Owns arithmetic, unit conversion, numerical estimation, percentages,
    and deterministic quantitative checks. Instructions: Compute carefully and show
    the relevant result.'
- source_sentence: Implement caching strategies to optimize API response times.
  sentences:
  - 'Documentation Engineer. Owns README files, specifications, API documentation,
    examples, migration notes, and user-facing explanations. Instructions: Keep documentation
    accurate, concise, and usable.'
  - 'Planner. Owns decomposition, architecture, dependencies, sequencing, and coordination
    of multi-agent implementation work. Instructions: Turn broad work into coherent
    executable plans.'
  - 'Calculator. Owns arithmetic, unit conversion, numerical estimation, percentages,
    and deterministic quantitative checks. Instructions: Compute carefully and show
    the relevant result.'
pipeline_tag: sentence-similarity
library_name: sentence-transformers
---

# SentenceTransformer

This is a [sentence-transformers](https://www.SBERT.net) model trained. It maps inputs to a 384-dimensional dense vector space and can be used for semantic textual similarity, semantic search, paraphrase mining, classification, clustering, and more.

## Model Details

### Model Description
- **Model Type:** Sentence Transformer
<!-- - **Base model:** [Unknown](https://huggingface.co/unknown) -->
- **Maximum Sequence Length:** 256 tokens
- **Output Dimensionality:** 384 dimensions
- **Similarity Function:** Cosine Similarity
- **Supported Modality:** Text
<!-- - **Training Dataset:** Unknown -->
<!-- - **Language:** Unknown -->
<!-- - **License:** Unknown -->

### Model Sources

- **Documentation:** [Sentence Transformers Documentation](https://sbert.net)
- **Repository:** [Sentence Transformers on GitHub](https://github.com/huggingface/sentence-transformers)
- **Hugging Face:** [Sentence Transformers on Hugging Face](https://huggingface.co/models?library=sentence-transformers)

### Full Model Architecture

```
SentenceTransformer(
  (0): Transformer({'transformer_task': 'feature-extraction', 'modality_config': {'text': {'method': 'forward', 'method_output_name': 'last_hidden_state'}}, 'module_output_name': 'token_embeddings', 'architecture': 'BertModel'})
  (1): Pooling({'embedding_dimension': 384, 'pooling_mode': 'mean', 'include_prompt': True})
  (2): Normalize({'module_input_name': 'sentence_embedding', 'module_output_name': 'sentence_embedding'})
)
```

## Usage

### Direct Usage (Sentence Transformers)

First install the Sentence Transformers library:

```bash
pip install -U sentence-transformers
```
Then you can load this model and run inference.
```python
from sentence_transformers import SentenceTransformer

# Download from the 🤗 Hub
model = SentenceTransformer("sentence_transformers_model_id")
# Run inference
sentences = [
    'Implement caching strategies to optimize API response times.',
    'Planner. Owns decomposition, architecture, dependencies, sequencing, and coordination of multi-agent implementation work. Instructions: Turn broad work into coherent executable plans.',
    'Calculator. Owns arithmetic, unit conversion, numerical estimation, percentages, and deterministic quantitative checks. Instructions: Compute carefully and show the relevant result.',
]
embeddings = model.encode(sentences)
print(embeddings.shape)
# [3, 384]

# Get the similarity scores for the embeddings
similarities = model.similarity(embeddings, embeddings)
print(similarities)
# tensor([[1.0000, 0.3504, 0.4222],
#         [0.3504, 1.0000, 0.3367],
#         [0.4222, 0.3367, 1.0000]])
```
<!--
### Direct Usage (Transformers)

<details><summary>Click to see the direct usage in Transformers</summary>

</details>
-->

<!--
### Downstream Usage (Sentence Transformers)

You can finetune this model on your own dataset.

<details><summary>Click to expand</summary>

</details>
-->

<!--
### Out-of-Scope Use

*List how the model may foreseeably be misused and address what users ought not to do with the model.*
-->

<!--
## Bias, Risks and Limitations

*What are the known or foreseeable issues stemming from this model? You could also flag here known failure cases or weaknesses of the model.*
-->

<!--
### Recommendations

*What are recommendations with respect to the foreseeable issues? For example, filtering explicit content.*
-->

## Training Details

### Training Dataset

#### Unnamed Dataset

* Size: 11,900 training samples
* Columns: <code>sentence_0</code>, <code>sentence_1</code>, and <code>label</code>
* Approximate statistics based on the first 100 samples:
  |          | sentence_0                                                                         | sentence_1                                                                         | label                                                          |
  |:---------|:-----------------------------------------------------------------------------------|:-----------------------------------------------------------------------------------|:---------------------------------------------------------------|
  | type     | string                                                                             | string                                                                             | float                                                          |
  | modality | text                                                                               | text                                                                               |                                                                |
  | details  | <ul><li>min: 11 tokens</li><li>mean: 20.72 tokens</li><li>max: 72 tokens</li></ul> | <ul><li>min: 34 tokens</li><li>mean: 37.21 tokens</li><li>max: 40 tokens</li></ul> | <ul><li>min: 0.0</li><li>mean: 0.07</li><li>max: 1.0</li></ul> |
* Samples:
  | sentence_0                                                                                               | sentence_1                                                                                                                                                                                                             | label            |
  |:---------------------------------------------------------------------------------------------------------|:-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|:-----------------|
  | <code>Develop a full-stack feature that allows users to submit feedback on their experiences.</code>     | <code>QA Engineer. Owns regression tests, integration tests, test fixtures, reproducibility, and verification of behavior across boundaries. Instructions: Find regressions and add focused automated coverage.</code> | <code>0.0</code> |
  | <code>Update the README to include instructions for setting up the local development environment.</code> | <code>Planner. Owns decomposition, architecture, dependencies, sequencing, and coordination of multi-agent implementation work. Instructions: Turn broad work into coherent executable plans.</code>                   | <code>0.0</code> |
  | <code>Refactor the existing backend code to improve performance and scalability.</code>                  | <code>Documentation Engineer. Owns README files, specifications, API documentation, examples, migration notes, and user-facing explanations. Instructions: Keep documentation accurate, concise, and usable.</code>    | <code>0.0</code> |
* Loss: [<code>ContrastiveLoss</code>](https://sbert.net/docs/package_reference/sentence_transformer/losses.html#contrastiveloss) with these parameters:
  ```json
  {
      "distance_metric": "SiameseDistanceMetric.COSINE_DISTANCE",
      "margin": 0.5,
      "size_average": true
  }
  ```

### Training Hyperparameters
#### Non-Default Hyperparameters

- `per_device_train_batch_size`: 16
- `num_train_epochs`: 1
- `per_device_eval_batch_size`: 16
- `multi_dataset_batch_sampler`: round_robin

#### All Hyperparameters
<details><summary>Click to expand</summary>

- `per_device_train_batch_size`: 16
- `num_train_epochs`: 1
- `max_steps`: -1
- `learning_rate`: 5e-05
- `lr_scheduler_type`: linear
- `lr_scheduler_kwargs`: None
- `warmup_steps`: 0
- `optim`: adamw_torch_fused
- `optim_args`: None
- `weight_decay`: 0.0
- `adam_beta1`: 0.9
- `adam_beta2`: 0.999
- `adam_epsilon`: 1e-08
- `optim_target_modules`: None
- `gradient_accumulation_steps`: 1
- `average_tokens_across_devices`: True
- `max_grad_norm`: 1
- `label_smoothing_factor`: 0.0
- `bf16`: False
- `fp16`: False
- `bf16_full_eval`: False
- `fp16_full_eval`: False
- `tf32`: None
- `gradient_checkpointing`: False
- `gradient_checkpointing_kwargs`: None
- `torch_compile`: False
- `torch_compile_backend`: None
- `torch_compile_mode`: None
- `use_liger_kernel`: False
- `liger_kernel_config`: None
- `use_cache`: False
- `neftune_noise_alpha`: None
- `torch_empty_cache_steps`: None
- `auto_find_batch_size`: False
- `log_on_each_node`: True
- `logging_nan_inf_filter`: True
- `include_num_input_tokens_seen`: no
- `log_level`: passive
- `log_level_replica`: warning
- `disable_tqdm`: False
- `project`: huggingface
- `trackio_space_id`: None
- `trackio_bucket_id`: None
- `trackio_static_space_id`: None
- `per_device_eval_batch_size`: 16
- `prediction_loss_only`: True
- `eval_on_start`: False
- `eval_do_concat_batches`: True
- `eval_use_gather_object`: False
- `eval_accumulation_steps`: None
- `include_for_metrics`: []
- `batch_eval_metrics`: False
- `save_only_model`: False
- `save_on_each_node`: False
- `enable_jit_checkpoint`: False
- `push_to_hub`: False
- `hub_private_repo`: None
- `hub_model_id`: None
- `hub_strategy`: every_save
- `hub_always_push`: False
- `hub_revision`: None
- `load_best_model_at_end`: False
- `ignore_data_skip`: False
- `restore_callback_states_from_checkpoint`: False
- `full_determinism`: False
- `seed`: 42
- `data_seed`: None
- `use_cpu`: False
- `accelerator_config`: {'split_batches': False, 'dispatch_batches': None, 'even_batches': True, 'use_seedable_sampler': True, 'non_blocking': False, 'gradient_accumulation_kwargs': None}
- `parallelism_config`: None
- `dataloader_drop_last`: False
- `dataloader_num_workers`: 0
- `dataloader_pin_memory`: True
- `dataloader_persistent_workers`: False
- `dataloader_prefetch_factor`: None
- `dataloader_multiprocessing_context`: None
- `dataloader_in_order`: True
- `remove_unused_columns`: True
- `label_names`: None
- `train_sampling_strategy`: random
- `length_column_name`: length
- `ddp_find_unused_parameters`: None
- `ddp_bucket_cap_mb`: None
- `ddp_broadcast_buffers`: False
- `ddp_static_graph`: None
- `ddp_backend`: None
- `ddp_timeout`: 1800
- `fsdp`: None
- `fsdp_config`: None
- `deepspeed`: None
- `debug`: []
- `skip_memory_metrics`: True
- `do_predict`: False
- `resume_from_checkpoint`: None
- `local_rank`: -1
- `prompts`: None
- `batch_sampler`: batch_sampler
- `multi_dataset_batch_sampler`: round_robin
- `router_mapping`: {}
- `learning_rate_mapping`: {}
- `warmup_ratio`: None

</details>

### Training Logs
| Epoch  | Step | Training Loss |
|:------:|:----:|:-------------:|
| 0.6720 | 500  | 0.0024        |


### Training Time
- **Training**: 3.4 minutes

### Framework Versions
- Python: 3.12.7
- Sentence Transformers: 6.0.0
- Transformers: 5.16.1
- PyTorch: 2.13.0
- Accelerate: 1.14.0
- Datasets: 5.0.1
- Tokenizers: 0.23.1

## Additional Resources

- [Training and Finetuning Embedding Models with Sentence Transformers](https://huggingface.co/blog/train-sentence-transformers): the end-to-end guide for training or finetuning Sentence Transformer models.
- [Introduction to Matryoshka Embedding Models](https://huggingface.co/blog/matryoshka): variable-size embeddings that can be truncated with minimal quality loss.
- [Binary and Scalar Embedding Quantization for Significantly Faster & Cheaper Retrieval](https://huggingface.co/blog/embedding-quantization): post-training compression of embedding vectors.
- [Multimodal Embedding & Reranker Models with Sentence Transformers](https://huggingface.co/blog/multimodal-sentence-transformers): use text, image, audio, and video models through the same API.
- [Training and Finetuning Multimodal Embedding & Reranker Models with Sentence Transformers](https://huggingface.co/blog/train-multimodal-sentence-transformers): train multimodal embedding models, with a Visual Document Retrieval walkthrough.

## Citation

### BibTeX

#### Sentence Transformers
```bibtex
@inproceedings{reimers-2019-sentence-bert,
    title = "Sentence-BERT: Sentence Embeddings using Siamese BERT-Networks",
    author = "Reimers, Nils and Gurevych, Iryna",
    booktitle = "Proceedings of the 2019 Conference on Empirical Methods in Natural Language Processing",
    month = "11",
    year = "2019",
    publisher = "Association for Computational Linguistics",
    url = "https://arxiv.org/abs/1908.10084",
}
```

#### ContrastiveLoss
```bibtex
@inproceedings{hadsell2006dimensionality,
    author={Hadsell, R. and Chopra, S. and LeCun, Y.},
    booktitle={2006 IEEE Computer Society Conference on Computer Vision and Pattern Recognition (CVPR'06)},
    title={Dimensionality Reduction by Learning an Invariant Mapping},
    year={2006},
    volume={2},
    number={},
    pages={1735-1742},
    doi={10.1109/CVPR.2006.100}
}
```

<!--
## Glossary

*Clearly define terms in order to be accessible across audiences.*
-->

<!--
## Model Card Authors

*Lists the people who create the model card, providing recognition and accountability for the detailed work that goes into its construction.*
-->

<!--
## Model Card Contact

*Provides a way for people who have updates to the Model Card, suggestions, or questions, to contact the Model Card authors.*
-->