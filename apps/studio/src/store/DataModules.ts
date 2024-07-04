import { LocalConnectionFolderModule } from "@/store/modules/data/connection_folder/LocalConnectionFolderModule";
import { LocalQueryFolderModule } from "@/store/modules/data/query_folder/LocalQueryFolderModule";
import { LocalUsedQueryModule } from "@/store/modules/data/used_query/LocalUsedQueryModule";
import { UtilConnectionModule } from "./modules/data/connection/UtilityConnectionModule";
import { UtilQueryModule } from "./modules/data/query/UtilityQueryModule";
import { UtilUsedConnectionModule } from "./modules/data/used_connection/UtilityUsedConnectionModule";


export const DataModules = [
  {
    path: 'data/queries',
    local: UtilQueryModule,
    cloud: null,
  },
  {
    path: 'data/connections',
    cloud: null,
    local: UtilConnectionModule
  },
  {
    path: 'data/queryFolders',
    cloud: null,
    local: LocalQueryFolderModule
  },
  {
    path: 'data/connectionFolders',
    cloud: null,
    local: LocalConnectionFolderModule
  },
  {
    path: 'data/usedQueries',
    cloud: null,
    local: LocalUsedQueryModule,
  },
  {
    path: 'data/usedconnections',
    cloud: null,
    local: UtilUsedConnectionModule
  }

]
